// macOS builds are not signed with a Developer ID. Seal the whole bundle with an ad-hoc signature so
// Apple Silicon accepts it (otherwise only the main binary is linker-signed and Gatekeeper reports "damaged").
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // a real identity signs instead
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
