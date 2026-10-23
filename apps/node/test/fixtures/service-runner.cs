using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class Runner {
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') {
        slashes++;
        continue;
      }
      if (character == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(character);
      slashes = 0;
    }
    result.Append('\\', slashes * 2).Append('"');
    return result.ToString();
  }

  public static int Main(string[] args) {
    var command = new StringBuilder(Quote(Environment.GetEnvironmentVariable("MATE_FAKE_SERVICE_SCRIPT")));
    command.Append(' ').Append(Quote(Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0])));
    foreach (string argument in args) command.Append(' ').Append(Quote(argument));
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("MATE_TEST_NODE"), command.ToString());
    start.UseShellExecute = false;
    var child = Process.Start(start);
    child.WaitForExit();
    return child.ExitCode;
  }
}
