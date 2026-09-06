import * as fs from 'fs/promises';
import * as path from 'path';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function backupFile(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  const backupDirectory = getBackupDirectory(filePath);
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDirectory, `${path.basename(filePath)}.${timestamp()}.bak`);
  await fs.copyFile(filePath, backupPath);
  await fs.chmod(backupPath, 0o600);
  return backupPath;
}

export async function deleteBackups(filePath: string): Promise<number> {
  const backupDirectory = getBackupDirectory(filePath);
  let entries;
  try { entries = await fs.readdir(backupDirectory, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.bak')) continue;
    await fs.unlink(path.join(backupDirectory, entry.name));
    removed += 1;
  }
  return removed;
}

export function getBackupDirectory(filePath: string): string {
  return path.join(path.dirname(filePath), 'vscodemodelswitchbak');
}

export async function directorySize(directory: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) {
      try { total += (await fs.stat(entryPath)).size; } catch { /* File changed during the scan. */ }
    }
  }
  return total;
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}
