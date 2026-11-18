import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = 'hub.lock';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

/**
 * One hub per config dir: a second one would reconcile the first one's live runs as interrupted (it sees `running`
 * cards with no run in its own process). Takes over a lock whose process is gone; returns the release.
 * shortcut: a reused PID of a dead hub reads as alive, so the start fails with the message below; delete the file then.
 */
export async function acquireHubLock(configDir: string, pid: number = process.pid): Promise<() => void> {
  await mkdir(configDir, { recursive: true });
  const file = join(configDir, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(file, 'wx');
      await fh.writeFile(String(pid));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e;
      const holder = Number((await readFile(file, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        throw new Error(
          `another Taskcell Hub (pid ${holder}) already uses ${configDir}. Stop it first, or give this one its own TASKCELL_HUB_CONFIG_DIR. (If no hub runs, delete ${file}.)`,
        );
      }
      await unlink(file).catch(() => {});
    }
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return release;
}
