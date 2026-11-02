// Compiles grab.exe, the fast GDI screen grabber, with the C# compiler that ships with .NET Framework 4.
// Windows only. Runs on `npm install`; if it fails, ArtNote falls back to Electron's slower desktopCapturer.
const { execFileSync } = require('child_process');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);
const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const args = ['-nologo', '-optimize', '-target:winexe', '-out:grab.exe', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', 'grab.cs'];
try {
  execFileSync(csc, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
} catch (err) {
  console.warn(`grab.exe was not built (${err.message.split('\n')[0]}); ArtNote will use the slower desktopCapturer`);
}
