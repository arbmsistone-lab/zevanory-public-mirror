import chromium from '@sparticuz/chromium';

const path = await chromium.executablePath();
if (!path) {
  console.error('SERVERLESS_CHROMIUM_PATH_MISSING');
  process.exit(1);
}
console.log(path);
