import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDsn } from '../dsn.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const CONCURRENCY = 4;

const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

export const HELP = `Usage:
  argos-sourcemaps upload --release <release> [--api <url>] [--project <id> | --dsn <dsn>]
                          [--token <t>] [--include-sources] [--dry-run] <dir> [<dir>...]

Uploads every *.map under the given directories (node_modules skipped) to an
Argos release, so minified stack frames resolve to your original code.

Options:
  --release <release>  Required. Must be exactly the \`release\` passed to
                       Sentry.init / the Argos SDK init, or frames won't resolve.
                       Env: ARGOS_RELEASE
  --api <url>          Argos API base URL, e.g. https://argos.example.com.
                       Env: ARGOS_API_URL
  --project <id>       Project id. Or give --dsn (env ARGOS_DSN) and it is read
                       from the DSN.
  --dsn <dsn>          The project's DSN, used only for its project id.
  --token <t>          Upload token from the app page in Argos. Prefer the env
                       var ARGOS_UPLOAD_TOKEN: a flag shows in the process list.
  --include-sources    Also upload the .js/.mjs/.cjs file next to each map.
  --dry-run            List what would be uploaded, send nothing.
  -h, --help           Show this help.

Files are named by their path relative to the directory given, with forward
slashes: dist/assets/app.js.map uploaded from "dist" is "assets/app.js.map".

Exit codes: 0 all uploaded, 1 an upload failed, 2 bad usage.
`;

export interface Io {
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface Config {
  release: string;
  api: string;
  project: string;
  token: string;
  includeSources: boolean;
  dryRun: boolean;
  dirs: string[];
}

export interface UploadFile {
  path: string;
  name: string;
  kind: 'source_map' | 'source';
  size: number;
}

export class UsageError extends Error {}

export function resolveConfig(argv: string[], env: Record<string, string | undefined>): Config {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        release: { type: 'string' },
        api: { type: 'string' },
        project: { type: 'string' },
        dsn: { type: 'string' },
        token: { type: 'string' },
        'include-sources': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command = '(none)', ...dirs] = positionals;
  if (command !== 'upload') throw new UsageError(`unknown command: ${command}`);
  if (dirs.length === 0) throw new UsageError('give at least one directory to scan');

  const release = values.release ?? env.ARGOS_RELEASE;
  if (!release) throw new UsageError('--release (or ARGOS_RELEASE) is required');
  const api = (values.api ?? env.ARGOS_API_URL)?.replace(/\/+$/, '');
  if (!api) throw new UsageError('--api (or ARGOS_API_URL) is required');

  let project = values.project;
  if (!project) {
    const dsn = values.dsn ?? env.ARGOS_DSN;
    if (!dsn) throw new UsageError('--project, --dsn or ARGOS_DSN is required');
    try {
      project = parseDsn(dsn).projectId;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  const dryRun = values['dry-run'];
  const token = values.token ?? env.ARGOS_UPLOAD_TOKEN ?? '';
  if (!token && !dryRun) throw new UsageError('--token (or ARGOS_UPLOAD_TOKEN) is required');

  return { release, api, project, token, includeSources: values['include-sources'], dryRun, dirs };
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/** app.js.map pairs with app.js; app.map with app.js, app.mjs or app.cjs. */
async function pairedSource(mapPath: string): Promise<string | undefined> {
  const stem = mapPath.slice(0, -'.map'.length);
  const candidates = SOURCE_EXTENSIONS.some((ext) => stem.endsWith(ext))
    ? [stem]
    : SOURCE_EXTENSIONS.map((ext) => stem + ext);
  for (const candidate of candidates) {
    if ((await sizeOf(candidate)) !== undefined) return candidate;
  }
  return undefined;
}

export async function collect(dirs: string[], includeSources: boolean): Promise<UploadFile[]> {
  const files: UploadFile[] = [];
  for (const dir of dirs) {
    const nameOf = (path: string): string => relative(dir, path).split(sep).join('/');
    for await (const path of walk(dir)) {
      if (!path.endsWith('.map')) continue;
      files.push({ path, name: nameOf(path), kind: 'source_map', size: (await sizeOf(path)) ?? 0 });
      if (!includeSources) continue;
      const source = await pairedSource(path);
      if (source) {
        files.push({
          path: source,
          name: nameOf(source),
          kind: 'source',
          size: (await sizeOf(source)) ?? 0,
        });
      }
    }
  }
  return files;
}

export function uploadUrl(config: Config, file: UploadFile): string {
  const query = new URLSearchParams({ name: file.name, kind: file.kind });
  return `${config.api}/api/projects/${encodeURIComponent(config.project)}/releases/${encodeURIComponent(config.release)}/files?${query.toString()}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

class Abort extends Error {}

const FATAL: Record<number, string> = {
  401: 'the upload token was rejected (wrong, revoked, or for another installation)',
  404: 'project not found: check --project / the DSN against --api',
};

type Outcome = 'uploaded' | 'skipped' | 'failed';

async function uploadOne(config: Config, file: UploadFile, io: Io): Promise<Outcome> {
  const label = `${file.name}  ${formatSize(file.size)}`;
  if (file.size > MAX_FILE_BYTES) {
    io.err(`skipped   ${label}  larger than 20 MiB`);
    return 'skipped';
  }
  const body = await readFile(file.path);
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    let status: number | string;
    try {
      const response = await io.fetch(uploadUrl(config, file), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/octet-stream',
        },
        body,
      });
      if (response.ok) {
        io.out(`uploaded  ${label}  ${String(response.status)}`);
        return 'uploaded';
      }
      const fatal = FATAL[response.status];
      if (fatal) throw new Abort(`${String(response.status)}: ${fatal}`);
      if (response.status === 413) {
        io.err(`failed    ${label}  413 too large for the server`);
        return 'failed';
      }
      status = response.status;
      if (status < 500) {
        io.err(`failed    ${label}  ${String(status)}`);
        return 'failed';
      }
    } catch (error) {
      if (error instanceof Abort) throw error;
      status = `network error: ${(error as Error).message}`;
    }
    if (attempt >= 1) {
      io.err(`failed    ${label}  ${String(status)}`);
      return 'failed';
    }
    await sleep(1000);
  }
}

export async function upload(config: Config, files: UploadFile[], io: Io): Promise<number> {
  const counts: Record<Outcome, number> = { uploaded: 0, skipped: 0, failed: 0 };
  let next = 0;
  let aborted: Abort | undefined;

  const worker = async (): Promise<void> => {
    while (!aborted && next < files.length) {
      const file = files[next++];
      try {
        counts[await uploadOne(config, file, io)]++;
      } catch (error) {
        if (error instanceof Abort) {
          aborted ??= error;
        } else {
          io.err(`failed    ${file.name}  ${(error as Error).message}`);
          counts.failed++;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  if (aborted) {
    io.err(`aborted: ${aborted.message}`);
    return 1;
  }
  io.out(
    `${String(counts.uploaded)} uploaded, ${String(counts.skipped)} skipped, ${String(counts.failed)} failed (release ${config.release})`,
  );
  return counts.failed > 0 ? 1 : 0;
}

export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    io.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  let config: Config;
  try {
    config = resolveConfig(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`argos-sourcemaps: ${error.message}\n\n${HELP}`);
    return 2;
  }

  // Defense in depth: nothing we print should ever carry the token, even echoed back.
  const mask = (line: string): string =>
    config.token ? line.split(config.token).join('***') : line;
  const safe: Io = {
    ...io,
    out: (l) => {
      io.out(mask(l));
    },
    err: (l) => {
      io.err(mask(l));
    },
  };

  let files: UploadFile[];
  try {
    files = await collect(config.dirs, config.includeSources);
  } catch (error) {
    safe.err(`argos-sourcemaps: ${(error as Error).message}`);
    return 2;
  }
  if (files.length === 0) {
    safe.err('no .map files found; is the build emitting source maps?');
    return 1;
  }

  if (config.dryRun) {
    for (const file of files) {
      safe.out(`would upload  ${file.name}  ${formatSize(file.size)}  ${file.kind}`);
    }
    safe.out(
      `${String(files.length)} files for release ${config.release} to ${config.api} project ${config.project} (dry run)`,
    );
    return 0;
  }
  return upload(config, files, safe);
}
