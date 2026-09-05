using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class KeySender {
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint uAction, uint uParam, IntPtr lpvParam, uint fuWinIni);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);

    public static void EnsureInputDesktop() {
        try {
            SystemParametersInfo(0x2001, 0, IntPtr.Zero, 0x02 | 0x01);
            IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
        } catch {}
    }

    public static void FocusPresentationWindow() {
        EnsureInputDesktop();

        IntPtr fg = GetForegroundWindow();
        uint fgPid = 0;
        if (fg != IntPtr.Zero) {
            GetWindowThreadProcessId(fg, out fgPid);
        }

        // Check if full-screen slide show exists (PowerPoint screenClass)
        IntPtr hSlideShow = FindWindow("screenClass", null);
        if (hSlideShow != IntPtr.Zero) {
            uint ssPid;
            GetWindowThreadProcessId(hSlideShow, out ssPid);
            if (fgPid != ssPid) {
                SetForegroundWindow(hSlideShow);
                BringWindowToTop(hSlideShow);
            }
            return;
        }

        // Check if PowerPoint editor frame exists (PPTFrameClass)
        IntPtr hFrame = FindWindow("PPTFrameClass", null);
        if (hFrame != IntPtr.Zero) {
            uint framePid;
            GetWindowThreadProcessId(hFrame, out framePid);
            if (fgPid != framePid) {
                ShowWindow(hFrame, 9); // SW_RESTORE
                SetForegroundWindow(hFrame);
                BringWindowToTop(hFrame);
            }
            return;
        }

        // Fallback: search other presentation windows (Google Slides, Acrobat, etc.)
        IntPtr target = IntPtr.Zero;
        uint targetPid = 0;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (title.IndexOf("PowerPoint", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Slide Show", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Google Slides", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Acrobat", StringComparison.OrdinalIgnoreCase) >= 0) {
                target = hWnd;
                GetWindowThreadProcessId(hWnd, out targetPid);
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (target != IntPtr.Zero && fgPid != targetPid) {
            ShowWindow(target, 9);
            SetForegroundWindow(target);
            BringWindowToTop(target);
        }
    }

    public static void PressKey(ushort vk, bool extended = false) {
        EnsureInputDesktop();
        FocusPresentationWindow();
        Thread.Sleep(20);

        ushort scan = (ushort)MapVirtualKey(vk, 0);
        uint extFlag = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        int size = Marshal.SizeOf(typeof(INPUT));

        INPUT[] down = new INPUT[1];
        down[0].type = INPUT_KEYBOARD;
        down[0].u.ki.wVk = vk;
        down[0].u.ki.wScan = scan;
        down[0].u.ki.dwFlags = extFlag;
        SendInput(1, down, size);

        Thread.Sleep(25);

        INPUT[] up = new INPUT[1];
        up[0].type = INPUT_KEYBOARD;
        up[0].u.ki.wVk = vk;
        up[0].u.ki.wScan = scan;
        up[0].u.ki.dwFlags = extFlag | KEYEVENTF_KEYUP;
        SendInput(1, up, size);
    }

    public static void PressCombo(ushort modifier, ushort vk) {
        EnsureInputDesktop();
        FocusPresentationWindow();
        Thread.Sleep(20);

        ushort scanMod = (ushort)MapVirtualKey(modifier, 0);
        ushort scanVk = (ushort)MapVirtualKey(vk, 0);
        int size = Marshal.SizeOf(typeof(INPUT));

        INPUT[] down1 = new INPUT[1];
        down1[0].type = INPUT_KEYBOARD;
        down1[0].u.ki.wVk = modifier;
        down1[0].u.ki.wScan = scanMod;
        SendInput(1, down1, size);
        Thread.Sleep(15);

        INPUT[] down2 = new INPUT[1];
        down2[0].type = INPUT_KEYBOARD;
        down2[0].u.ki.wVk = vk;
        down2[0].u.ki.wScan = scanVk;
        SendInput(1, down2, size);
        Thread.Sleep(25);

        INPUT[] up2 = new INPUT[1];
        up2[0].type = INPUT_KEYBOARD;
        up2[0].u.ki.wVk = vk;
        up2[0].u.ki.wScan = scanVk;
        up2[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(1, up2, size);
        Thread.Sleep(15);

        INPUT[] up1 = new INPUT[1];
        up1[0].type = INPUT_KEYBOARD;
        up1[0].u.ki.wVk = modifier;
        up1[0].u.ki.wScan = scanMod;
        up1[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(1, up1, size);
    }

    public static void Main(string[] args) {
        EnsureInputDesktop();
        Console.WriteLine("KEYSENDER_READY");
        string line;
        while ((line = Console.ReadLine()) != null) {
            line = line.Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(line)) continue;

            switch (line) {
                // --- PowerPoint / Universal Next / Prev ---
                // PageDown (0x22) advances slides in BOTH fullscreen slideshow mode and edit view.
                case "NEXT_ARROW":
                case "NEXT_PPT":
                    PressKey(0x22, true); // VK_NEXT (Page Down)
                    break;
                case "PREV_ARROW":
                case "PREV_PPT":
                    PressKey(0x21, true); // VK_PRIOR (Page Up)
                    break;

                // --- Dedicated Page Down / Page Up ---
                case "NEXT_PGDN":
                    PressKey(0x22, true);
                    break;
                case "PREV_PGUP":
                    PressKey(0x21, true);
                    break;

                // --- Space / Backspace ---
                case "NEXT_SPACE":
                    PressKey(0x20, false);
                    break;
                case "PREV_BACKSPACE":
                    PressKey(0x08, false);
                    break;

                // --- Down / Up Arrow ---
                case "NEXT_DOWN":
                    PressKey(0x28, true);
                    break;
                case "PREV_UP":
                    PressKey(0x26, true);
                    break;

                // --- Presentation control ---
                case "F5":
                    PressKey(0x74, false); // VK_F5 (Start Slideshow)
                    break;
                case "SHIFT_F5":
                    PressCombo(0x10, 0x74); // Shift + F5 (Start From Current Slide)
                    break;
                case "ESC":
                    PressKey(0x1B, false); // VK_ESCAPE
                    break;
                case "B":
                    PressKey(0x42, false); // 'B' (Black Screen Toggle)
                    break;
                case "W":
                    PressKey(0x57, false); // 'W' (White Screen Toggle)
                    break;
                case "PERIOD":
                    PressKey(0xBE, false);
                    break;

                // --- System ---
                case "PING":
                    Console.WriteLine("PONG");
                    continue;
                case "QUIT":
                    return;
                default:
                    Console.WriteLine("UNKNOWN:" + line);
                    continue;
            }
            Console.WriteLine("OK:" + line);
        }
    }
}
