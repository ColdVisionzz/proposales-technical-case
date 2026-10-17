// Scripts and tests run outside Next.js, so they read .env themselves. A missing file is fine (CI sets real env vars).
export function loadDotEnv() {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
