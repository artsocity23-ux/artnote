// Screen grabber for ArtNote: Electron's desktopCapturer needs ~1s per capture, a GDI copy takes a few ms.
// Every line on stdin produces one capture of the whole virtual screen on stdout:
// int32 x, y, width, height (little endian, physical pixels), then width*height*4 bytes of BGRA.
// Build: npm run grab
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Grab {
  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  static void Main() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2: real pixels
    Stream stdout = Console.OpenStandardOutput();
    while (Console.In.ReadLine() != null) {
      Rectangle r = SystemInformation.VirtualScreen;
      byte[] pixels = new byte[r.Width * r.Height * 4];
      using (Bitmap bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
        BitmapData data = bmp.LockBits(new Rectangle(0, 0, r.Width, r.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        bmp.UnlockBits(data);
      }
      for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
      byte[] header = new byte[16];
      BitConverter.GetBytes(r.X).CopyTo(header, 0);
      BitConverter.GetBytes(r.Y).CopyTo(header, 4);
      BitConverter.GetBytes(r.Width).CopyTo(header, 8);
      BitConverter.GetBytes(r.Height).CopyTo(header, 12);
      stdout.Write(header, 0, header.Length);
      stdout.Write(pixels, 0, pixels.Length);
      stdout.Flush();
    }
  }
}
