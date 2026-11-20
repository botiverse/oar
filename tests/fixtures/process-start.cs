using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;

class FixtureProcessStart {
    static int Main(string[] args) {
        int pid = int.Parse(args[0], CultureInfo.InvariantCulture);
        try {
            using (Process process = Process.GetProcessById(pid)) {
                if (args.Length == 1) {
                    Console.WriteLine(process.StartTime.ToUniversalTime().Ticks);
                    return 0;
                }
                // Keep a handle to this process through the comparison and termination.
                // Windows cannot recycle the PID while this handle is held.
                IntPtr handle = process.Handle;
                string start = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
                if (start != args[1]) { return 1; }
                try { process.Kill(); }
                catch (Win32Exception) { if (!process.HasExited) { throw; } return 1; }
                return 0;
            }
        } catch (ArgumentException) {
            return 1;
        } catch (InvalidOperationException) {
            // Process exited during observation.
            return 1;
        }
    }
}
