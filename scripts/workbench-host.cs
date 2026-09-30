using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class WorkbenchHost {
  const int Port = 47321;
  static readonly string Root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));

  // 实际绑上的监听范围："all" = 所有网卡（局域网可访问）| "local" = 只有本机。
  // 只用 127.0.0.1 时说明缺少 http://+:<port>/ 的 URL 保留（需要管理员执行一次）。
  static string ListenScope = "local";

  [DllImport("user32.dll")]
  static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);

  [DllImport("user32.dll")]
  static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  static extern bool AddClipboardFormatListener(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool RemoveClipboardFormatListener(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  static extern bool UnhookWindowsHookEx(IntPtr hhk);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr GetModuleHandle(string lpModuleName);

  [DllImport("user32.dll")]
  static extern short GetAsyncKeyState(int vKey);

  delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

  [DllImport("user32.dll")]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

  [DllImport("user32.dll")]
  static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);

  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  static extern bool EnumThreadWindows(uint threadId, EnumWindowsProc callback, IntPtr param);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hWnd, out WindowRect rect);

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

  [StructLayout(LayoutKind.Sequential)]
  struct WindowRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  static void Main() {
    // 控制台宿主默认「DPI 不感知」，系统会把对话框先按 96dpi 画再拉伸，结果就是糊。
    // 声明 DPI 感知后由 WinForms 自己按真实 DPI 缩放，字才是清楚的。
    try { SetProcessDPIAware(); } catch (Exception) { }
    HttpListener listener = StartListener();
    if (listener == null) return;
    StartScreenshotHotkey();
    ThreadPool.QueueUserWorkItem(delegate { Listen(listener); });
    Thread.Sleep(Timeout.Infinite);
  }

  // 优先监听所有网卡（局域网设备可访问）；未授权监听时回退到仅本机
  static HttpListener StartListener() {
    string[] prefixes = new string[] { "http://+:" + Port + "/", "http://127.0.0.1:" + Port + "/" };
    for (int i = 0; i < prefixes.Length; i++) {
      HttpListener listener = new HttpListener();
      listener.Prefixes.Add(prefixes[i]);
      try {
        listener.Start();
        ListenScope = prefixes[i].StartsWith("http://+", StringComparison.Ordinal) ? "all" : "local";
        return listener;
      } catch (Exception) {
        try { listener.Close(); } catch (Exception) { }
      }
    }
    return null;
  }

  static void Listen(HttpListener listener) {
    while (listener.IsListening) {
      HttpListenerContext context;
      try {
        context = listener.GetContext();
      } catch (HttpListenerException) {
        return;
      }
      ThreadPool.QueueUserWorkItem(delegate { Handle(context); });
    }
  }

  static void Handle(HttpListenerContext context) {
    try {
      HttpListenerRequest request = context.Request;
      HttpListenerResponse response = context.Response;
      string origin = request.Headers["Origin"];
      bool ownOrigin = string.Equals(origin, "http://127.0.0.1:" + Port, StringComparison.OrdinalIgnoreCase);
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/open", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string path;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          path = reader.ReadToEnd().Trim();
        }
        if (!OpenFolder(path)) {
          Send(response, 400, "text/plain", "bad path");
          return;
        }
        Send(response, 204, "text/plain", "");
        return;
      }

      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/catalog/save", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string saveError = SaveCatalog(request);
        if (saveError != null) {
          Send(response, 400, "text/plain", saveError);
          return;
        }
        Send(response, 204, "text/plain", "");
        return;
      }

      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/sync-db", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        SyncIndex(response);
        return;
      }

      // 通用工具启动：exe 路径来自 meta.json 的 tools 字段，改工具不必重新编译服务端
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/run-tool", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string body;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          body = reader.ReadToEnd();
        }
        string failure = RunToolFromJson(body);
        if (failure != null) {
          Send(response, 400, "text/plain", failure);
          return;
        }
        Send(response, 204, "text/plain", "");
        return;
      }

      // 内置发布：直接做 UpdateVersion.ini 里配置的复制与版本号递增，不再需要外部 exe
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/publish", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string publishBody;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          publishBody = reader.ReadToEnd();
        }
        Send(response, 200, "application/json", PublishFromJson(publishBody));
        return;
      }

      // 旧路径保留为别名，避免已经打开的旧页面对不上
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          (string.Equals(request.Url.AbsolutePath, "/run-update-version", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(request.Url.AbsolutePath, "/run-template-tool", StringComparison.OrdinalIgnoreCase))) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string legacy = string.Equals(request.Url.AbsolutePath, "/run-update-version", StringComparison.OrdinalIgnoreCase)
          ? UpdateVersionExePath()
          : TemplateToolExePath();
        if (!File.Exists(legacy)) {
          Send(response, 404, "text/plain", "missing");
          return;
        }
        if (Launch(legacy, "", Path.GetDirectoryName(legacy)) != null) {
          Send(response, 404, "text/plain", "missing");
          return;
        }
        Send(response, 204, "text/plain", "");
        return;
      }

      // 用户指定配置文件位置
      if (string.Equals(request.Url.AbsolutePath, "/config", StringComparison.OrdinalIgnoreCase)) {
        if (string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase)) {
          if (!string.IsNullOrEmpty(origin) && !ownOrigin) {
            Send(response, 403, "text/plain", "forbidden");
            return;
          }
          Send(response, 200, "application/json", ReadConfigJson());
          return;
        }
        if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase)) {
          if (!ownOrigin) {
            Send(response, 403, "text/plain", "forbidden");
            return;
          }
          string configBody;
          using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
            configBody = reader.ReadToEnd();
          }
          string configError = WriteConfigJson(configBody);
          if (configError != null) {
            Send(response, 400, "text/plain", configError);
            return;
          }
          Send(response, 200, "application/json", ReadConfigJson());
          return;
        }
      }

      // 弹出 Windows 原生「打开」对话框选文件，选完把绝对路径回传
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/pick-file", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string pickBody;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          pickBody = reader.ReadToEnd();
        }
        Send(response, 200, "application/json", PickFileFromJson(pickBody));
        return;
      }

      // 资料库文件管理：只接受工作台本机页面发来的请求。前端只传已选择的根目录和相对路径，
      // 服务端再次做根目录约束，避免用 ../ 越出管理范围。
      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/library/list", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string libraryBody;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          libraryBody = reader.ReadToEnd();
        }
        Send(response, 200, "application/json", LibraryListJson(libraryBody));
        return;
      }

      if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/library/open", StringComparison.OrdinalIgnoreCase)) {
        if (!ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        string openBody;
        using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
          openBody = reader.ReadToEnd();
        }
        string openError = OpenLibraryItem(openBody);
        if (openError != null) {
          Send(response, 400, "text/plain", openError);
          return;
        }
        Send(response, 204, "text/plain", "");
        return;
      }

      // 浏览目录：给「浏览…」用，列出驱动器 / 子目录 / .ini 文件
      if (string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase) &&
          string.Equals(request.Url.AbsolutePath, "/fs/list", StringComparison.OrdinalIgnoreCase)) {
        // 同源的 GET 浏览器不带 Origin，所以只在"带了 Origin 且不是本机"时才拒绝
        if (!string.IsNullOrEmpty(origin) && !ownOrigin) {
          Send(response, 403, "text/plain", "forbidden");
          return;
        }
        Send(response, 200, "application/json", ListDirectory(QueryValue(request, "path")));
        return;
      }

      if (string.Equals(request.Url.AbsolutePath, "/update-version-ini", StringComparison.OrdinalIgnoreCase)) {
        if (string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase)) {
          if (!string.IsNullOrEmpty(origin) && !ownOrigin) {
            Send(response, 403, "text/plain", "forbidden");
            return;
          }
          Send(response, 200, "application/json", ReadVersionIniJson());
          return;
        }
        if (string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase)) {
          if (!ownOrigin) {
            Send(response, 403, "text/plain", "forbidden");
            return;
          }
          string body;
          using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
            body = reader.ReadToEnd();
          }
          string error = WriteVersionIni(body);
          if (error != null) {
            Send(response, 400, "text/plain", error);
            return;
          }
          Send(response, 204, "text/plain", "");
          return;
        }
      }

      // git 代码仓库：把本机 git 能力转接给前端（浏览器不能自己开进程）
      if (request.Url.AbsolutePath.StartsWith("/git/", StringComparison.OrdinalIgnoreCase)) {
        HandleGit(context, ownOrigin);
        return;
      }

      if (request.Url.AbsolutePath.StartsWith("/lan/", StringComparison.OrdinalIgnoreCase)) {
        HandleLan(context);
        return;
      }

      if (!string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase) &&
          !string.Equals(request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase)) {
        Send(response, 405, "text/plain", "method");
        return;
      }

      string relative = Uri.UnescapeDataString(request.Url.AbsolutePath);
      if (relative == "/") relative = "/index.html";
      relative = relative.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
      if (relative.IndexOf("..", StringComparison.Ordinal) >= 0 || IsBlocked(relative)) {
        Send(response, 404, "text/plain", "not found");
        return;
      }
      string full = Path.GetFullPath(Path.Combine(Root, relative));
      string rootPrefix = Root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
      if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) {
        Send(response, 404, "text/plain", "not found");
        return;
      }
      SendStatic(request, response, full);
    } catch (Exception) {
      try { context.Response.Abort(); } catch (Exception) { }
    }
  }

  // ===== 局域网传文件 =====
  // 接收目录固定在工作台下的 lan/，只允许写入扁平文件名，防目录穿越。

  static string LanDir() {
    string dir = Path.Combine(Root, "lan");
    Directory.CreateDirectory(dir);
    return dir;
  }

  static bool SafeFileName(string name) {
    if (string.IsNullOrEmpty(name) || name.Length > 180) return false;
    if (name == "." || name == ".." || name[0] == '.') return false;
    return name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;
  }

  static string UniquePath(string dir, string name) {
    string candidate = Path.Combine(dir, name);
    if (!File.Exists(candidate)) return candidate;
    string baseName = Path.GetFileNameWithoutExtension(name);
    string ext = Path.GetExtension(name);
    for (int i = 1; i < 10000; i++) {
      candidate = Path.Combine(dir, baseName + " (" + i + ")" + ext);
      if (!File.Exists(candidate)) return candidate;
    }
    return Path.Combine(dir, Guid.NewGuid().ToString("N") + ext);
  }

  // 排除虚拟/隧道网卡（Hyper-V、VMware、VirtualBox 等），它们对局域网不可达
  static bool IsVirtualAdapter(string description) {
    string text = (description ?? "").ToLowerInvariant();
    string[] keywords = new string[] {
      "hyper-v", "virtual", "vmware", "virtualbox", "loopback", "pseudo",
      "tunnel", "teredo", "tap-", "wintun", "bluetooth", "vpn", "zerotier", "tailscale"
    };
    for (int i = 0; i < keywords.Length; i++) {
      if (text.IndexOf(keywords[i], StringComparison.Ordinal) >= 0) return true;
    }
    return false;
  }

  static string LanInfoJson() {
    List<string> urls = new List<string>();
    try {
      NetworkInterface[] adapters = NetworkInterface.GetAllNetworkInterfaces();
      for (int i = 0; i < adapters.Length; i++) {
        NetworkInterface adapter = adapters[i];
        if (adapter.OperationalStatus != OperationalStatus.Up) continue;
        NetworkInterfaceType type = adapter.NetworkInterfaceType;
        if (type == NetworkInterfaceType.Loopback || type == NetworkInterfaceType.Tunnel) continue;
        if (IsVirtualAdapter(adapter.Description)) continue;
        UnicastIPAddressInformationCollection addresses = adapter.GetIPProperties().UnicastAddresses;
        for (int j = 0; j < addresses.Count; j++) {
          IPAddress address = addresses[j].Address;
          if (address.AddressFamily != AddressFamily.InterNetwork) continue;
          string text = address.ToString();
          if (text.StartsWith("127.") || text.StartsWith("169.254.")) continue;
          urls.Add("http://" + text + ":" + Port + "/lan.html");
        }
      }
    } catch (Exception) { }
    urls.Sort(delegate (string a, string b) {
      bool pa = a.StartsWith("http://192.168.");
      bool pb = b.StartsWith("http://192.168.");
      if (pa != pb) return pa ? -1 : 1;
      return string.CompareOrdinal(a, b);
    });
    Dictionary<string, object> root = new Dictionary<string, object>();
    root["port"] = Port;
    root["dir"] = "lan";
    root["scope"] = ListenScope;
    // 只绑到 127.0.0.1 时，下面这些局域网地址其实连不上，页面据此改成提示而不是给假地址
    root["urls"] = ListenScope == "all" ? urls : new List<string>();
    return new JavaScriptSerializer().Serialize(root);
  }

  // 列出某个子目录：文件夹在前、文件在后，便于页面上分区展示
  static string LanListJson(string rel) {
    string dir = string.IsNullOrEmpty(rel) ? LanDir() : LanPathOf(rel);
    Dictionary<string, object> root = new Dictionary<string, object>();
    if (dir == null || !Directory.Exists(dir)) {
      root["error"] = "目录不存在";
      return new JavaScriptSerializer().Serialize(root);
    }

    List<Dictionary<string, object>> dirs = new List<Dictionary<string, object>>();
    List<Dictionary<string, object>> files = new List<Dictionary<string, object>>();
    try {
      DirectoryInfo info = new DirectoryInfo(dir);
      DirectoryInfo[] subs = info.GetDirectories();
      Array.Sort(subs, delegate (DirectoryInfo a, DirectoryInfo b) {
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
      });
      for (int i = 0; i < subs.Length; i++) {
        if (subs[i].Name.Length > 0 && subs[i].Name[0] == '.') continue;
        Dictionary<string, object> item = new Dictionary<string, object>();
        item["name"] = subs[i].Name;
        item["mtime"] = subs[i].LastWriteTime.ToString("yyyy-MM-dd HH:mm");
        dirs.Add(item);
      }
      FileInfo[] items = info.GetFiles();
      Array.Sort(items, delegate (FileInfo a, FileInfo b) { return b.LastWriteTime.CompareTo(a.LastWriteTime); });
      for (int i = 0; i < items.Length; i++) {
        Dictionary<string, object> item = new Dictionary<string, object>();
        item["name"] = items[i].Name;
        item["size"] = items[i].Length;
        item["mtime"] = items[i].LastWriteTime.ToString("yyyy-MM-dd HH:mm");
        files.Add(item);
      }
    } catch (Exception ex) {
      root["error"] = ex.Message;
      return new JavaScriptSerializer().Serialize(root);
    }
    root["path"] = rel == null ? "" : rel;
    root["dirs"] = dirs;
    root["files"] = files;
    return new JavaScriptSerializer().Serialize(root);
  }

  // HttpListener 的 QueryString 按系统 ANSI 解码，中文文件名会乱码，这里显式按 UTF-8 解析
  static string QueryValue(HttpListenerRequest request, string key) {
    string query = request.Url.Query;
    if (string.IsNullOrEmpty(query) || query.Length < 2) return null;
    string[] parts = query.Substring(1).Split('&');
    for (int i = 0; i < parts.Length; i++) {
      if (parts[i].Length == 0) continue;
      int eq = parts[i].IndexOf('=');
      string rawKey = eq < 0 ? parts[i] : parts[i].Substring(0, eq);
      if (!string.Equals(Uri.UnescapeDataString(rawKey), key, StringComparison.Ordinal)) continue;
      string rawValue = eq < 0 ? "" : parts[i].Substring(eq + 1);
      return Uri.UnescapeDataString(rawValue.Replace("+", "%20"));
    }
    return null;
  }

  static void HandleLan(HttpListenerContext context) {
    HttpListenerRequest request = context.Request;
    HttpListenerResponse response = context.Response;
    string path = request.Url.AbsolutePath.ToLowerInvariant();
    string method = request.HttpMethod.ToUpperInvariant();
    string name = QueryValue(request, "name");
    string rel = QueryValue(request, "path");

    if (path == "/lan/info" && method == "GET") {
      Send(response, 200, "application/json", LanInfoJson());
      return;
    }

    // 列目录：path 为空时列 lan/ 根，否则列它的子目录
    if (path == "/lan/list" && method == "GET") {
      Send(response, 200, "application/json", LanListJson(rel));
      return;
    }

    if (path == "/lan/get" && (method == "GET" || method == "HEAD")) {
      bool head = method == "HEAD";
      string folder = QueryValue(request, "folder");
      if (!string.IsNullOrEmpty(folder)) {
        // 文件夹：现场打成 zip 再发
        string dir = LanPathOf(folder);
        if (dir == null || dir == LanDir() || !Directory.Exists(dir)) {
          Send(response, 404, "text/plain", "not found");
          return;
        }
        SendFolderZip(response, dir, folder);
        return;
      }
      string parent = string.IsNullOrEmpty(rel) ? LanDir() : LanPathOf(rel);
      if (parent == null || !SafeFileName(name)) {
        Send(response, 400, "text/plain", "bad name");
        return;
      }
      string full = Path.Combine(parent, name);
      if (!File.Exists(full)) {
        Send(response, 404, "text/plain", "not found");
        return;
      }
      SendFileStream(response, full, name, head);
      return;
    }

    if (path == "/lan/put" && method == "POST") {
      // name 允许是 "子目录/文件名"：上传整个文件夹时按相对路径还原
      string target = LanTargetFile(name);
      if (target == null) {
        Send(response, 400, "text/plain", "bad name");
        return;
      }
      string unique = UniquePath(Path.GetDirectoryName(target), Path.GetFileName(target));
      try {
        using (FileStream output = new FileStream(unique, FileMode.CreateNew, FileAccess.Write)) {
          byte[] buffer = new byte[81920];
          int read;
          while ((read = request.InputStream.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, read);
          }
        }
      } catch (Exception ex) {
        Send(response, 500, "text/plain", ex.Message);
        return;
      }
      string relative = unique.Substring(LanDir().Length).TrimStart(Path.DirectorySeparatorChar, '/').Replace('\\', '/');
      Send(response, 200, "application/json", "{\"ok\":true,\"name\":\"" + JsonEscape(relative) + "\"}");
      return;
    }

    if (path == "/lan/delete" && method == "POST") {
      bool isFolder = string.Equals(QueryValue(request, "type"), "folder", StringComparison.OrdinalIgnoreCase);
      try {
        if (isFolder) {
          string dir = LanPathOf(name);
          if (dir == null || dir == LanDir() || !Directory.Exists(dir)) {
            Send(response, 400, "text/plain", "bad name");
            return;
          }
          Directory.Delete(dir, true);
        } else {
          string full = LanPathOf(name);
          if (full == null) {
            Send(response, 400, "text/plain", "bad name");
            return;
          }
          if (File.Exists(full)) File.Delete(full);
        }
      } catch (Exception ex) {
        Send(response, 500, "text/plain", ex.Message);
        return;
      }
      Send(response, 200, "application/json", "{\"ok\":true}");
      return;
    }

    Send(response, 404, "text/plain", "not found");
  }

  /* ===== lan/ 下的路径解析（文件夹支持）=====
     一律把 "a/b/c.txt" 拆成段，逐段按文件名规则校验，拒绝 .. 和空段，
     因此结果一定还在 lan/ 里面；最多 12 层，防止超深目录。 */

  static List<string> SplitRel(string rel) {
    if (string.IsNullOrEmpty(rel)) return null;
    string[] parts = rel.Split(new char[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length == 0 || parts.Length > 12) return null;
    List<string> clean = new List<string>();
    for (int i = 0; i < parts.Length; i++) {
      string part = parts[i].Trim();
      if (part.Length == 0 || part == "." || part == "..") return null;
      if (!SafeFileName(part)) return null;
      clean.Add(part);
    }
    return clean;
  }

  static string LanPathOf(string rel) {
    List<string> parts = SplitRel(rel);
    if (parts == null) return null;
    string full = LanDir();
    for (int i = 0; i < parts.Count; i++) full = Path.Combine(full, parts[i]);
    return full;
  }

  // 上传用：父目录不存在就建出来
  static string LanTargetFile(string rel) {
    List<string> parts = SplitRel(rel);
    if (parts == null) return null;
    string dir = LanDir();
    for (int i = 0; i < parts.Count - 1; i++) dir = Path.Combine(dir, parts[i]);
    try {
      if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
    } catch (Exception) {
      return null;
    }
    return Path.Combine(dir, parts[parts.Count - 1]);
  }

  // 分块发送，避免大文件一次性读进内存
  static void SendFileStream(HttpListenerResponse response, string full, string downloadName, bool head) {
    long length = new FileInfo(full).Length;
    response.StatusCode = 200;
    response.ContentType = "application/octet-stream";
    response.Headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + Uri.EscapeDataString(downloadName);
    response.ContentLength64 = length;
    if (head) {
      response.OutputStream.Close();
      return;
    }
    try {
      using (FileStream input = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        byte[] buffer = new byte[262144];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
          response.OutputStream.Write(buffer, 0, read);
        }
      }
    } finally {
      response.OutputStream.Close();
    }
  }

  // 打包下载：先落一个临时 zip，再分块发出去，最后删掉临时文件
  static void SendFolderZip(HttpListenerResponse response, string dir, string folderRel) {
    string temp = Path.Combine(Path.GetTempPath(), "wb-lan-" + Guid.NewGuid().ToString("N") + ".zip");
    try {
      using (FileStream output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write)) {
        using (ZipArchive archive = new ZipArchive(output, ZipArchiveMode.Create)) {
          AddDirectoryToZip(archive, dir, "");
        }
      }
      string[] zipParts = folderRel.Split(new char[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
      string downloadName = (zipParts.Length > 0 ? zipParts[zipParts.Length - 1] : "files") + ".zip";
      response.StatusCode = 200;
      response.ContentType = "application/zip";
      response.Headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + Uri.EscapeDataString(downloadName);
      response.ContentLength64 = new FileInfo(temp).Length;
      using (FileStream input = new FileStream(temp, FileMode.Open, FileAccess.Read)) {
        byte[] buffer = new byte[262144];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0) {
          response.OutputStream.Write(buffer, 0, read);
        }
      }
      response.OutputStream.Close();
    } catch (Exception ex) {
      try {
        Send(response, 500, "text/plain", "打包失败：" + ex.Message);
      } catch (Exception) { }
    } finally {
      try {
        if (File.Exists(temp)) File.Delete(temp);
      } catch (Exception) { }
    }
  }

  static void AddDirectoryToZip(ZipArchive archive, string dir, string prefix) {
    DirectoryInfo info = new DirectoryInfo(dir);
    FileInfo[] files = info.GetFiles();
    for (int i = 0; i < files.Length; i++) {
      try {
        ZipArchiveEntry entry = archive.CreateEntry(prefix + files[i].Name);
        using (Stream src = new FileStream(files[i].FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
          using (Stream dst = entry.Open()) {
            src.CopyTo(dst);
          }
        }
      } catch (Exception) { }
    }
    DirectoryInfo[] subs = info.GetDirectories();
    for (int i = 0; i < subs.Length; i++) {
      if (subs[i].Name.Length > 0 && subs[i].Name[0] == '.') continue;
      AddDirectoryToZip(archive, subs[i].FullName, prefix + subs[i].Name + "/");
    }
  }

  static bool IsBlocked(string relative) {
    string[] parts = relative.Split(Path.DirectorySeparatorChar);
    for (int i = 0; i < parts.Length; i++) {
      string part = parts[i];
      if (part.Length == 0) continue;
      if (part[0] == '.') return true;
      if (string.Equals(part, "Obsidian Notes", StringComparison.OrdinalIgnoreCase)) return true;
      if (string.Equals(part, "scripts", StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  const string UpdateVersionExe = @"C:\Git Repository\Update_Version_Software\x64\Release\Update_Version_Software.exe";
  const string TemplateToolExe = @"C:\Tool\TemplateTool\TemplateMakingTool.Views.WPF.exe";
  const string NasDb = @"\\ZH-mfS-SRV.OPLINK.COM.CN\Passive\EDFATemp\42233\otdr_index.db";
  static readonly Encoding IniEncoding = Encoding.GetEncoding(936);
  static readonly Encoding RawEncoding = Encoding.GetEncoding(28591);

  // 工作台根目录下的可选配置，用来覆盖上面这些写死的路径：
  // { "updateVersionIni": "...", "updateVersionExe": "...", "templateToolExe": "..." }
  static readonly string ConfigPath = Path.Combine(Root, "workbench.config.json");

  static Dictionary<string, object> ReadConfig() {
    try {
      if (!File.Exists(ConfigPath)) return new Dictionary<string, object>();
      Dictionary<string, object> config =
        new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigPath, Encoding.UTF8));
      return config == null ? new Dictionary<string, object>() : config;
    } catch (Exception) {
      return new Dictionary<string, object>();
    }
  }

  static string ConfiguredPath(string key, string fallback) {
    string value = ValueOf(ReadConfig(), key).Trim();
    return value.Length > 0 ? value : fallback;
  }

  static string UpdateVersionExePath() {
    return ConfiguredPath("updateVersionExe", UpdateVersionExe);
  }

  static string TemplateToolExePath() {
    return ConfiguredPath("templateToolExe", TemplateToolExe);
  }

  // UpdateVersion.ini 的位置完全由用户指定，不做任何自动查找；
  // 没有配置时返回空串，由调用方提示用户去设置。
  static string ResolveIniPath() {
    return ValueOf(ReadConfig(), "updateVersionIni").Trim();
  }

  static readonly string[] ConfigKeys = new string[] { "updateVersionIni", "updateVersionExe", "templateToolExe" };

  static string ReadConfigJson() {
    Dictionary<string, object> config = ReadConfig();
    Dictionary<string, object> values = new Dictionary<string, object>();
    for (int i = 0; i < ConfigKeys.Length; i++) {
      values[ConfigKeys[i]] = ValueOf(config, ConfigKeys[i]).Trim();
    }

    string iniPath = ResolveIniPath();
    Dictionary<string, object> root = new Dictionary<string, object>();
    root["values"] = values;
    root["configPath"] = ConfigPath;
    root["configExists"] = File.Exists(ConfigPath);
    root["iniPath"] = iniPath;
    root["configured"] = iniPath.Length > 0;
    root["iniExists"] = iniPath.Length > 0 && File.Exists(iniPath);
    return new JavaScriptSerializer().Serialize(root);
  }

  // 弹原生文件对话框。必须放在 STA 线程上，否则 Win32 通用对话框行为不稳。
  // POST /pick-file：弹 Windows 原生对话框。
  //   mode=file（默认）选文件，mode=dir 选目录。
  //   mode 不认识就直接报错 —— 绝不能弹窗：弹了没人点，这个请求会一直挂着。
  static string PickFileFromJson(string body) {
    string initial = "";
    string mode = "file";
    string title = "";
    List<string> extensions = new List<string>();
    try {
      Dictionary<string, object> request =
        new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
      if (request != null) {
        initial = ValueOf(request, "path").Trim();
        title = ValueOf(request, "title").Trim();
        string wanted = ValueOf(request, "mode").Trim().ToLowerInvariant();
        if (wanted.Length > 0) mode = wanted;
        extensions = ReadExtensions(request);
      }
    } catch (Exception) { }

    if (!mode.Equals("file") && !mode.Equals("dir")) {
      Dictionary<string, object> bad = new Dictionary<string, object>();
      bad["ok"] = false;
      bad["error"] = "不认识的选择模式：" + mode;
      return new JavaScriptSerializer().Serialize(bad);
    }
    // 标题会直接写进对话框，截断并去掉换行，避免奇怪的窗口
    title = title.Replace('\r', ' ').Replace('\n', ' ').Trim();
    if (title.Length > 40) title = title.Substring(0, 40);

    string picked = "";
    string failure = "";
    Thread worker = new Thread(delegate() {
      try {
        picked = mode.Equals("dir")
          ? ShowPickFolderDialog(initial, title)
          : ShowPickFileDialog(initial, title, extensions);
      } catch (Exception ex) {
        failure = ex.Message;
      }
    });
    worker.SetApartmentState(ApartmentState.STA);
    worker.IsBackground = true;
    worker.Start();
    worker.Join();

    Dictionary<string, object> result = new Dictionary<string, object>();
    if (failure.Length > 0) {
      result["ok"] = false;
      result["error"] = failure;
    } else {
      result["ok"] = true;
      result["path"] = picked;
      result["cancelled"] = picked.Length == 0;
    }
    return new JavaScriptSerializer().Serialize(result);
  }

  // 扩展名只用来拼对话框的过滤串，必须逐个校验
  static List<string> ReadExtensions(Dictionary<string, object> request) {
    List<string> list = new List<string>();
    object raw;
    if (request == null || !request.TryGetValue("extensions", out raw)) return list;
    IEnumerable items = raw as IEnumerable;
    if (items == null || raw is string) return list;
    foreach (object item in items) {
      if (item == null) continue;
      string ext = Convert.ToString(item).Trim().ToLowerInvariant();
      if (ext.Length == 0) continue;
      if (ext[0] != '.') ext = "." + ext;
      if (!Regex.IsMatch(ext, "^\\.[a-z0-9]{1,10}$")) continue;
      if (!list.Contains(ext)) list.Add(ext);
    }
    return list;
  }

  // 后台进程默认抢不到前台，得先临时把自己的线程和当前前台线程的输入队列接上
  static void ForceForeground(IntPtr window) {
    if (window == IntPtr.Zero) return;
    try {
      uint thisThread = GetCurrentThreadId();
      IntPtr foreground = GetForegroundWindow();
      uint targetThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
      bool joined = false;
      if (targetThread != 0 && targetThread != thisThread) {
        joined = AttachThreadInput(thisThread, targetThread, true);
      }
      BringWindowToTop(window);
      SetForegroundWindow(window);
      if (joined) AttachThreadInput(thisThread, targetThread, false);
    } catch (Exception) { }
  }

  // 找本线程上那个像文件对话框的窗口（排除我们那个 1×1 的 owner）
  static IntPtr FindDialogWindow(IntPtr exclude) {
    IntPtr found = IntPtr.Zero;
    try {
      EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr hWnd, IntPtr param) {
        if (hWnd == exclude) return true;
        if (!IsWindowVisible(hWnd)) return true;
        WindowRect rect;
        if (!GetWindowRect(hWnd, out rect)) return true;
        if (rect.Right - rect.Left < 200 || rect.Bottom - rect.Top < 150) return true;
        found = hWnd;
        return false;
      }, IntPtr.Zero);
    } catch (Exception) { }
    return found;
  }

  // 初始目录：给的是文件路径就取它所在目录；不存在就留空
  static string InitialDirectory(string initial) {
    string dir = (initial == null ? "" : initial).Trim();
    if (dir.Length > 0) {
      try {
        if (!Directory.Exists(dir)) dir = Path.GetDirectoryName(dir);
      } catch (Exception) {
        dir = "";
      }
    }
    if (dir == null || dir.Length == 0 || !Directory.Exists(dir)) dir = "";
    return dir;
  }

  static string BuildFileFilter(List<string> extensions) {
    if (extensions == null || extensions.Count == 0) return "配置文件 (*.ini)|*.ini|所有文件 (*.*)|*.*";
    string pattern = "";
    string shown = "";
    for (int i = 0; i < extensions.Count; i++) {
      if (i > 0) {
        pattern += ";";
        shown += ",";
      }
      pattern += "*" + extensions[i];
      shown += extensions[i].TrimStart('.');
    }
    return shown + " 文件 (" + pattern + ")|" + pattern + "|所有文件 (*.*)|*.*";
  }

  static string ShowPickFileDialog(string initial, string title, List<string> extensions) {
    System.Windows.Forms.OpenFileDialog dialog = new System.Windows.Forms.OpenFileDialog();
    dialog.Title = title.Length > 0 ? title : "选择文件";
    dialog.Filter = BuildFileFilter(extensions);
    dialog.CheckFileExists = true;
    dialog.CheckPathExists = true;
    dialog.RestoreDirectory = true;
    string dir = InitialDirectory(initial);
    if (dir.Length > 0) dialog.InitialDirectory = dir;
    if (ShowModalDialog(dialog) != System.Windows.Forms.DialogResult.OK) return "";
    return dialog.FileName == null ? "" : dialog.FileName;
  }

  // 选目录：Windows 的文件夹选择对话框（可以顺手新建文件夹）
  static string ShowPickFolderDialog(string initial, string title) {
    System.Windows.Forms.FolderBrowserDialog dialog = new System.Windows.Forms.FolderBrowserDialog();
    dialog.Description = title.Length > 0 ? title : "选择目录";
    dialog.ShowNewFolderButton = true;
    string dir = InitialDirectory(initial);
    if (dir.Length > 0) dialog.SelectedPath = dir;
    if (ShowModalDialog(dialog) != System.Windows.Forms.DialogResult.OK) return "";
    return dialog.SelectedPath == null ? "" : dialog.SelectedPath;
  }

  // 模态对话框挂在一个屏幕外的置顶小窗上：既保证弹在最前面，也避免被摆到屏幕角落
  static System.Windows.Forms.DialogResult ShowModalDialog(System.Windows.Forms.CommonDialog dialog) {
    using (System.Windows.Forms.Form owner = new System.Windows.Forms.Form()) {
      owner.FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
      owner.ShowInTaskbar = false;
      // 通用对话框是相对 owner 定位的，owner 必须在屏幕中心，
      // 否则对话框会被摆到屏幕角落（之前放到屏幕外就踩了这个坑）。
      owner.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
      owner.Size = new System.Drawing.Size(1, 1);
      owner.Opacity = 0.01;
      owner.TopMost = true;
      owner.Show();
      owner.Activate();
      ForceForeground(owner.Handle);

      // 对话框弹出来之后再抢一次：它自己的模态消息循环会跑这个计时器
      System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer();
      ticker.Interval = 200;
      ticker.Tick += delegate {
        ticker.Stop();
        ticker.Dispose();
        ForceForeground(FindDialogWindow(owner.Handle));
      };
      ticker.Start();

      System.Windows.Forms.DialogResult result = dialog.ShowDialog(owner);
      owner.Close();
      return result;
    }
  }

  const int FsListLimit = 500;

  static string LibraryRelative(string rel) {
    string value = (rel == null ? "" : rel).Trim().Replace('/', '\\');
    while (value.StartsWith("\\")) value = value.Substring(1);
    return value;
  }

  static string LibraryPath(string root, string rel) {
    if (string.IsNullOrEmpty(root) || !Path.IsPathRooted(root)) return null;
    string basePath;
    string full;
    try {
      basePath = Path.GetFullPath(root);
      string driveRoot = Path.GetPathRoot(basePath);
      if (!string.Equals(basePath, driveRoot, StringComparison.OrdinalIgnoreCase)) basePath = basePath.TrimEnd('\\');
      full = Path.GetFullPath(Path.Combine(basePath, LibraryRelative(rel)));
    } catch (Exception) {
      return null;
    }
    if (string.Equals(full, basePath, StringComparison.OrdinalIgnoreCase)) return full;
    if (!full.StartsWith(basePath + "\\", StringComparison.OrdinalIgnoreCase)) return null;
    return full;
  }

  // 文件管理按层级懒加载，避免一次递归扫描 OneDrive 大目录拖慢页面。
  static string LibraryListJson(string body) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    string root = "";
    string rel = "";
    try {
      Dictionary<string, object> request =
        new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
      root = ValueOf(request, "root").Trim();
      rel = LibraryRelative(ValueOf(request, "path"));
    } catch (Exception) { }

    string dir = LibraryPath(root, rel);
    if (dir == null || !Directory.Exists(dir)) {
      result["error"] = dir == null ? "文件夹路径不合法" : "文件夹不存在或暂时无法访问";
      return new JavaScriptSerializer().Serialize(result);
    }

    List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();
    bool truncated = false;
    try {
      DirectoryInfo info = new DirectoryInfo(dir);
      FileSystemInfo[] children = info.GetFileSystemInfos();
      Array.Sort(children, delegate(FileSystemInfo a, FileSystemInfo b) {
        bool ad = (a.Attributes & FileAttributes.Directory) != 0;
        bool bd = (b.Attributes & FileAttributes.Directory) != 0;
        if (ad != bd) return ad ? -1 : 1;
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
      });
      for (int i = 0; i < children.Length; i++) {
        if (entries.Count >= 1000) { truncated = true; break; }
        FileSystemInfo child = children[i];
        bool isDir;
        try {
          isDir = (child.Attributes & FileAttributes.Directory) != 0;
          // 目录联接可能跳出根目录，也可能形成循环，不在页面中继续深入。
          if ((child.Attributes & FileAttributes.ReparsePoint) != 0) continue;
          Dictionary<string, object> item = new Dictionary<string, object>();
          string childRel = rel.Length == 0 ? child.Name : rel + "\\" + child.Name;
          item["name"] = child.Name;
          item["path"] = childRel.Replace('\\', '/');
          item["kind"] = isDir ? "dir" : "file";
          item["mtime"] = child.LastWriteTime.ToString("yyyy-MM-dd HH:mm");
          if (!isDir) {
            try { item["size"] = ((FileInfo)child).Length; }
            catch (Exception) { item["size"] = 0L; }
          }
          entries.Add(item);
        } catch (Exception) {
          continue;
        }
      }
      result["root"] = info.FullName;
    } catch (Exception ex) {
      result["error"] = ex.Message;
      return new JavaScriptSerializer().Serialize(result);
    }

    result["path"] = rel.Replace('\\', '/');
    int slash = rel.LastIndexOf('\\');
    result["parent"] = slash < 0 ? "" : rel.Substring(0, slash).Replace('\\', '/');
    result["entries"] = entries;
    result["truncated"] = truncated;
    return new JavaScriptSerializer().Serialize(result);
  }

  static string OpenLibraryItem(string body) {
    string root = "";
    string rel = "";
    string mode = "";
    try {
      Dictionary<string, object> request =
        new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
      root = ValueOf(request, "root").Trim();
      rel = ValueOf(request, "path").Trim();
      mode = ValueOf(request, "mode").Trim().ToLowerInvariant();
    } catch (Exception) {
      return "invalid json";
    }
    string full = LibraryPath(root, rel);
    if (full == null || (!Directory.Exists(full) && !File.Exists(full))) return "文件不存在";
    try {
      ProcessStartInfo start = new ProcessStartInfo();
      start.UseShellExecute = true;
      if (File.Exists(full) && mode != "select") {
        start.FileName = full;
      } else {
        start.FileName = Environment.GetEnvironmentVariable("SystemRoot") + "\\explorer.exe";
        start.Arguments = File.Exists(full) ? "/select,\"" + full + "\"" : "\"" + full + "\"";
      }
      Process.Start(start);
      return null;
    } catch (Exception ex) {
      return ex.Message;
    }
  }

  // 「浏览…」用的最小目录列表：不传路径时给驱动器，传了就给子目录 + .ini 文件
  static string ListDirectory(string rawPath) {
    string path = (rawPath == null ? "" : rawPath).Trim();
    Dictionary<string, object> root = new Dictionary<string, object>();
    List<Dictionary<string, object>> dirs = new List<Dictionary<string, object>>();
    List<Dictionary<string, object>> files = new List<Dictionary<string, object>>();

    if (path.Length == 0) {
      try {
        DriveInfo[] all = DriveInfo.GetDrives();
        for (int i = 0; i < all.Length; i++) {
          if (!all[i].IsReady) continue;
          Dictionary<string, object> drive = new Dictionary<string, object>();
          drive["name"] = all[i].Name;
          drive["path"] = all[i].Name;
          string label = "";
          try { label = all[i].VolumeLabel; } catch (Exception) { }
          drive["label"] = label;
          dirs.Add(drive);
        }
      } catch (Exception) { }
      root["mode"] = "drives";
      root["path"] = "";
      root["parent"] = "";
      root["dirs"] = dirs;
      root["files"] = files;
      root["truncated"] = false;
      return new JavaScriptSerializer().Serialize(root);
    }

    if (!Path.IsPathRooted(path)) {
      root["error"] = "需要完整路径，例如 D:\\folder";
      return new JavaScriptSerializer().Serialize(root);
    }
    if (!Directory.Exists(path)) {
      root["error"] = "目录不存在：" + path;
      return new JavaScriptSerializer().Serialize(root);
    }

    string full = path;
    string parent = "";
    bool truncated = false;
    try {
      DirectoryInfo info = new DirectoryInfo(path);
      full = info.FullName;
      DirectoryInfo up = info.Parent;
      if (up != null) parent = up.FullName;

      List<DirectoryInfo> kids = new List<DirectoryInfo>(info.GetDirectories());
      kids.Sort(delegate(DirectoryInfo a, DirectoryInfo b) {
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
      });
      for (int i = 0; i < kids.Count; i++) {
        if (dirs.Count >= FsListLimit) { truncated = true; break; }
        try {
          FileAttributes attrs = kids[i].Attributes;
          if ((attrs & FileAttributes.Hidden) != 0 || (attrs & FileAttributes.System) != 0) continue;
        } catch (Exception) {
          continue;
        }
        Dictionary<string, object> dir = new Dictionary<string, object>();
        dir["name"] = kids[i].Name;
        dir["path"] = kids[i].FullName;
        dirs.Add(dir);
      }

      List<FileInfo> entries = new List<FileInfo>(info.GetFiles("*.ini"));
      entries.Sort(delegate(FileInfo a, FileInfo b) {
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
      });
      for (int i = 0; i < entries.Count; i++) {
        if (files.Count >= FsListLimit) { truncated = true; break; }
        Dictionary<string, object> file = new Dictionary<string, object>();
        file["name"] = entries[i].Name;
        file["path"] = entries[i].FullName;
        file["size"] = entries[i].Length;
        files.Add(file);
      }
    } catch (Exception ex) {
      root["error"] = ex.Message;
      return new JavaScriptSerializer().Serialize(root);
    }

    root["mode"] = "list";
    root["path"] = full;
    root["parent"] = parent;
    root["dirs"] = dirs;
    root["files"] = files;
    root["truncated"] = truncated;
    return new JavaScriptSerializer().Serialize(root);
  }

  // 返回 null 表示写入成功
  static string WriteConfigJson(string body) {
    Dictionary<string, object> incoming;
    try {
      incoming = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
    } catch (Exception) {
      return "invalid json";
    }
    if (incoming == null) return "invalid json";

    // 只接受白名单键，避免这个接口变成任意内容写文件
    Dictionary<string, object> config = new Dictionary<string, object>();
    for (int i = 0; i < ConfigKeys.Length; i++) {
      string value = ValueOf(incoming, ConfigKeys[i]).Trim();
      if (value.IndexOfAny(new char[] { '\r', '\n' }) >= 0) return "路径里不能包含换行";
      if (value.Length > 0) config[ConfigKeys[i]] = value;
    }

    try {
      if (config.Count == 0) {
        if (File.Exists(ConfigPath)) File.Delete(ConfigPath);
      } else {
        File.WriteAllText(ConfigPath, new JavaScriptSerializer().Serialize(config), new UTF8Encoding(false));
      }
    } catch (Exception ex) {
      return ex.Message;
    }
    return null;
  }

  static string IniBesideExe() {
    return ResolveIniPath();
  }

  // 只允许启动这些类型，避免被当成通用的任意命令执行入口
  static readonly string[] AllowedExtensions = new string[] { ".exe", ".bat", ".cmd", ".com", ".lnk" };

  // 返回 null 表示启动成功，否则返回错误说明
  static string RunToolFromJson(string body) {
    Dictionary<string, object> root;
    try {
      root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
    } catch (Exception) {
      return "invalid json";
    }
    if (root == null) return "invalid json";
    string exe = ValueOf(root, "exe").Trim();
    string args = ValueOf(root, "args").Trim();
    string cwd = ValueOf(root, "cwd").Trim();
    if (exe.Length == 0) return "missing exe";
    char[] forbidden = new char[] { '\r', '\n' };
    if (exe.IndexOfAny(forbidden) >= 0 || args.IndexOfAny(forbidden) >= 0 || cwd.IndexOfAny(forbidden) >= 0) return "bad text";
    if (!Path.IsPathRooted(exe)) return "not rooted";
    string ext = Path.GetExtension(exe).ToLowerInvariant();
    if (Array.IndexOf(AllowedExtensions, ext) < 0) return "not allowed";
    if (!File.Exists(exe)) return "missing";
    if (cwd.Length == 0 || !Directory.Exists(cwd)) cwd = Path.GetDirectoryName(exe);
    return Launch(exe, args, cwd);
  }

  static string Launch(string exe, string args, string cwd) {
    ProcessStartInfo start = new ProcessStartInfo();
    start.FileName = exe;
    start.Arguments = args;
    start.WorkingDirectory = cwd;
    start.UseShellExecute = true;
    try {
      Process.Start(start);
    } catch (Exception ex) {
      return ex.Message;
    }
    return null;
  }

  /* ===== git 代码仓库 =====
     浏览器不能自己执行进程，所以把 git 能力转接到这里：
     客户端只描述"想做什么"（op + 字段），命令行由服务端按白名单模板拼装，
     所有参数先过校验，杜绝把分支名传成 -D 之类的参数注入。 */

  const int GitReadTimeout = 20000;
  const int GitNetTimeout = 180000;
  const int GitOutputLimit = 512 * 1024;
  const int GitScanLimit = 200;
  const int GitScanDepth = 6;
  const int GitParallel = 4;
  const int GitLogMax = 200;

  // 扫描时跳过的目录：这些里面几乎不可能有用户想管的仓库，钻进去只会拖慢
  static readonly string[] GitSkipDirs = new string[] {
    "node_modules", "bin", "obj", "dist", "packages", ".vs", "target", "vendor", "release", "debug", "out"
  };

  // 动作白名单：{paths} {ref} {name} {msgfile} 由校验后的字段替换
  static readonly Dictionary<string, string[]> GitOps = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
    { "fetch",         new string[] { "fetch", "--all", "--prune" } },
    { "pull",          new string[] { "pull", "--ff-only" } },
    { "push",          new string[] { "push" } },
    // 首次推送：本地分支还没有上游，普通 push 会被 git 拒绝。
    // 用 HEAD 而不是分支名，省掉一次分支名校验，也不会因为改名而失效。
    { "push-upstream", new string[] { "push", "--set-upstream", "origin", "HEAD" } },
    { "push-force",    new string[] { "push", "--force-with-lease" } },
    { "stage-all",     new string[] { "add", "-A" } },
    { "stage-paths",   new string[] { "add", "--", "{paths}" } },
    { "unstage-all",   new string[] { "reset", "--quiet", "HEAD", "--" } },
    { "unstage-paths", new string[] { "reset", "--quiet", "HEAD", "--", "{paths}" } },
    { "discard",       new string[] { "checkout", "--", "{paths}" } },
    { "commit",        new string[] { "commit", "-F", "{msgfile}" } },
    { "commit-amend",  new string[] { "commit", "--amend", "-F", "{msgfile}" } },
    { "checkout",      new string[] { "checkout", "{ref}" } },
    { "branch-new",    new string[] { "checkout", "-b", "{name}" } },
    { "branch-delete", new string[] { "branch", "-d", "{name}" } },
    { "tag-create",    new string[] { "tag", "-a", "{name}", "-F", "{msgfile}" } },
    { "tag-delete",    new string[] { "tag", "-d", "{name}" } },
    { "tag-push",      new string[] { "push", "origin", "{name}" } },
    { "reset-hard",    new string[] { "reset", "--hard", "{ref}" } },
    { "revert",        new string[] { "revert", "--no-edit", "{ref}" } },
    { "stash",         new string[] { "stash", "push", "--include-untracked" } },
    { "stash-pop",     new string[] { "stash", "pop" } }
    // 「设置远端」不在这张表里：origin 可能还不存在，需要先探测再决定 add 还是 set-url，
    // 由 GitRemoteSet 单独处理（URL 照样要过 SafeGitRemoteUrl 校验）。
  };

  static readonly string[] GitNetOps = new string[] { "fetch", "pull", "push", "push-upstream", "push-force", "tag-push" };
  static readonly Encoding GitEncoding = new UTF8Encoding(false);

  sealed class GitRun {
    public int code;
    public string stdout = "";
    public string stderr = "";
    public bool truncated;
    public bool timeout;
  }

  // 读流的线程用，避免为了限制体积把管道读崩
  sealed class GitStream {
    public StringBuilder text = new StringBuilder();
    public bool truncated;
  }

  static void HandleGit(HttpListenerContext context, bool ownOrigin) {
    HttpListenerRequest request = context.Request;
    HttpListenerResponse response = context.Response;
    // git 风险高：读写一律要求本机同源页面（局域网设备和 file:// 直接被拒）
    if (!string.Equals(request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase) || !ownOrigin) {
      Send(response, 403, "text/plain", "forbidden");
      return;
    }
    string path = request.Url.AbsolutePath.ToLowerInvariant();
    string body;
    using (StreamReader reader = new StreamReader(request.InputStream, Encoding.UTF8)) {
      body = reader.ReadToEnd();
    }
    Dictionary<string, object> payload;
    try {
      payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
    } catch (Exception) {
      Send(response, 400, "text/plain", "invalid json");
      return;
    }
    if (payload == null) {
      Send(response, 400, "text/plain", "invalid json");
      return;
    }
    if (GitExe().Length == 0) {
      Send(response, 200, "application/json",
        GitJson(GitFail("", "找不到 git.exe，请先安装 Git 或把它加入 PATH")));
      return;
    }

    if (path == "/git/scan") { Send(response, 200, "application/json", GitScanJson(payload)); return; }
    if (path == "/git/status") { Send(response, 200, "application/json", GitStatusJson(payload)); return; }
    if (path == "/git/log") { Send(response, 200, "application/json", GitLogJson(payload)); return; }
    if (path == "/git/diff") { Send(response, 200, "application/json", GitDiffJson(payload)); return; }
    if (path == "/git/branches") { Send(response, 200, "application/json", GitBranchesJson(payload)); return; }
    if (path == "/git/tags") { Send(response, 200, "application/json", GitTagsJson(payload)); return; }
    if (path == "/git/exec") { Send(response, 200, "application/json", GitExecJson(payload)); return; }
    Send(response, 404, "text/plain", "not found");
  }

  // ---- 响应拼装 ----

  static string GitJson(Dictionary<string, object> result) {
    return new JavaScriptSerializer().Serialize(result);
  }

  static Dictionary<string, object> GitFail(string repo, string message) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = false;
    result["repo"] = repo;
    result["exitCode"] = -1;
    result["stdout"] = "";
    result["stderr"] = message;
    result["truncated"] = false;
    result["timeout"] = false;
    return result;
  }

  static Dictionary<string, object> GitResult(string repo, GitRun run) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = !run.timeout && run.code == 0;
    result["repo"] = repo;
    result["exitCode"] = run.code;
    result["stdout"] = run.stdout;
    result["stderr"] = run.stderr;
    result["truncated"] = run.truncated;
    result["timeout"] = run.timeout;
    return result;
  }

  static string GitFirstLine(string text, string fallback) {
    string value = (text ?? "").Trim();
    if (value.Length == 0) return fallback;
    int cut = value.IndexOf('\n');
    if (cut >= 0) value = value.Substring(0, cut).Trim();
    return value.Length == 0 ? fallback : value;
  }

  // 从第 start 个字段拼回剩余部分（说明文字本身可能含分隔符）
  static string GitRest(string[] parts, int start) {
    if (parts.Length <= start) return "";
    StringBuilder builder = new StringBuilder();
    for (int i = start; i < parts.Length; i++) {
      if (i > start) builder.Append('\t');
      builder.Append(parts[i]);
    }
    return builder.ToString();
  }

  // ---- 校验 ----

  static List<string> GitRoots(Dictionary<string, object> payload) {
    List<string> roots = new List<string>();
    ArrayList raw = payload.ContainsKey("roots") ? payload["roots"] as ArrayList : null;
    if (raw == null) return roots;
    foreach (object item in raw) {
      string value = Convert.ToString(item).Trim();
      if (value.Length == 0) continue;
      try {
        if (!Path.IsPathRooted(value)) continue;
        string full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, '/');
        if (full.Length == 0) continue;
        if (!Directory.Exists(full)) continue;
        bool seen = false;
        for (int i = 0; i < roots.Count; i++) {
          if (string.Equals(roots[i], full, StringComparison.OrdinalIgnoreCase)) { seen = true; break; }
        }
        if (!seen) roots.Add(full);
      } catch (Exception) { }
    }
    return roots;
  }

  // 仓库必须存在、是 git 仓库、并且位于某个已登记的根目录之下
  static string GitRepo(List<string> roots, string raw, out string error) {
    error = "";
    string value = (raw ?? "").Trim();
    if (value.Length == 0) { error = "缺少仓库路径"; return ""; }
    if (!Path.IsPathRooted(value)) { error = "仓库路径必须是完整路径"; return ""; }
    string full;
    try {
      full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, '/');
    } catch (Exception) {
      error = "仓库路径不合法";
      return "";
    }
    if (full.Length == 0 || !Directory.Exists(full)) { error = "仓库目录不存在"; return ""; }
    if (roots.Count == 0) { error = "还没有设置代码根目录"; return ""; }
    bool allowed = false;
    for (int i = 0; i < roots.Count; i++) {
      string prefix = roots[i] + Path.DirectorySeparatorChar;
      if (string.Equals(full, roots[i], StringComparison.OrdinalIgnoreCase) ||
          full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { allowed = true; break; }
    }
    if (!allowed) { error = "这个仓库不在已登记的代码根目录里"; return ""; }
    if (!GitIsRepo(full)) { error = "这个目录不是 git 仓库"; return ""; }
    return full;
  }

  static bool GitIsRepo(string dir) {
    try {
      return Directory.Exists(Path.Combine(dir, ".git")) || File.Exists(Path.Combine(dir, ".git"));
    } catch (Exception) {
      return false;
    }
  }

  // 分支 / 标签名：不允许以 - 开头，不允许 .. 与 //，只放行 git 允许的安全字符
  static bool SafeGitName(string value) {
    if (string.IsNullOrEmpty(value) || value.Length > 120) return false;
    if (value[0] == '-' || value[0] == '.' || value[0] == '/') return false;
    if (value.EndsWith(".") || value.EndsWith("/")) return false;
    for (int i = 0; i < value.Length; i++) {
      char c = value[i];
      bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
        || c == '.' || c == '_' || c == '-' || c == '/';
      if (!ok) return false;
    }
    return value.IndexOf("..", StringComparison.Ordinal) < 0
      && value.IndexOf("//", StringComparison.Ordinal) < 0
      && value.IndexOf(".lock", StringComparison.OrdinalIgnoreCase) < 0;
  }

  // 版本引用（checkout / reset 用）：额外放行 ~ ^ @，够表达 HEAD~2、d0e1f2a、标签
  static bool SafeGitRef(string value) {
    if (string.IsNullOrEmpty(value) || value.Length > 120) return false;
    if (value[0] == '-') return false;
    for (int i = 0; i < value.Length; i++) {
      char c = value[i];
      bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
        || c == '.' || c == '_' || c == '-' || c == '/' || c == '~' || c == '^' || c == '@' || c == '{' || c == '}';
      if (!ok) return false;
    }
    return value.IndexOf("..", StringComparison.Ordinal) < 0;
  }

  // 仓库内相对路径：禁止 ../、绝对路径、盘符、控制字符；统一成 git 认识的斜杠
  static string SafeRepoPath(string value) {
    string path = (value ?? "").Trim().Replace('\\', '/');
    if (path.Length == 0 || path.Length > 1000) return null;
    if (path[0] == '/' || path[0] == '.') return null;
    if (path.IndexOf("..", StringComparison.Ordinal) >= 0) return null;
    for (int i = 0; i < path.Length; i++) {
      char c = path[i];
      if (c < ' ' || c == '"' || c == ':' || c == '*' || c == '?' || c == '|' || c == '<' || c == '>') return null;
    }
    return path;
  }

  static int GitInt(Dictionary<string, object> payload, string key, int fallback, int min, int max) {
    string text = ValueOf(payload, key).Trim();
    if (text.Length == 0) return fallback;
    int value;
    if (!int.TryParse(text, out value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  // ---- git 可执行文件 ----

  static string GitExePath = null;

  static string GitExe() {
    if (GitExePath != null) return GitExePath;
    string custom = (Environment.GetEnvironmentVariable("WB_GIT") ?? "").Trim();
    if (custom.Length > 0 && File.Exists(custom)) { GitExePath = custom; return GitExePath; }
    string[] guesses = new string[] {
      @"D:\Git\cmd\git.exe",
      @"C:\Program Files\Git\cmd\git.exe",
      @"C:\Program Files (x86)\Git\cmd\git.exe"
    };
    for (int i = 0; i < guesses.Length; i++) {
      if (File.Exists(guesses[i])) { GitExePath = guesses[i]; return GitExePath; }
    }
    string[] parts = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
    for (int i = 0; i < parts.Length; i++) {
      string dir = parts[i].Trim().Trim('"');
      if (dir.Length == 0) continue;
      try {
        string candidate = Path.Combine(dir, "git.exe");
        if (File.Exists(candidate)) { GitExePath = candidate; return GitExePath; }
      } catch (Exception) { }
    }
    GitExePath = "";
    return GitExePath;
  }

  // ---- 进程执行 ----

  static string GitJoinArgs(List<string> args) {
    StringBuilder builder = new StringBuilder();
    for (int i = 0; i < args.Count; i++) {
      if (i > 0) builder.Append(' ');
      builder.Append(GitQuote(args[i]));
    }
    return builder.ToString();
  }

  static string GitQuote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
    StringBuilder builder = new StringBuilder("\"");
    for (int i = 0; i < value.Length; i++) {
      if (value[i] == '"') builder.Append('\\');
      builder.Append(value[i]);
    }
    builder.Append('"');
    return builder.ToString();
  }

  static void GitReadInto(StreamReader reader, GitStream target) {
    try {
      char[] buffer = new char[8192];
      int read;
      while ((read = reader.Read(buffer, 0, buffer.Length)) > 0) {
        if (target.text.Length < GitOutputLimit) {
          int room = GitOutputLimit - target.text.Length;
          target.text.Append(buffer, 0, Math.Min(room, read));
          if (room < read) target.truncated = true;
        } else {
          target.truncated = true;
        }
      }
    } catch (Exception) { }
  }

  // Kill() 不会带走子进程（git 可能拉起 ssh / 编辑器），用 taskkill 连树一起收
  static void GitKillTree(Process process) {
    try {
      ProcessStartInfo kill = new ProcessStartInfo();
      kill.FileName = "taskkill";
      kill.Arguments = "/PID " + process.Id + " /T /F";
      kill.UseShellExecute = false;
      kill.CreateNoWindow = true;
      kill.RedirectStandardOutput = true;
      kill.RedirectStandardError = true;
      Process killer = Process.Start(kill);
      if (killer != null) {
        try { killer.WaitForExit(5000); } catch (Exception) { }
        killer.Dispose();
      }
    } catch (Exception) { }
    try { if (!process.HasExited) process.Kill(); } catch (Exception) { }
  }

  // 跑一条 git 命令：不用 shell、不弹窗、UTF-8、带超时与输出上限
  static GitRun RunGit(string repo, List<string> args, int timeoutMs) {
    GitRun result = new GitRun();
    ProcessStartInfo start = new ProcessStartInfo();
    start.FileName = GitExe();
    List<string> all = new List<string>();
    all.Add("--no-pager");
    all.Add("-c");
    all.Add("core.quotepath=false");
    all.Add("-c");
    all.Add("i18n.logOutputEncoding=UTF-8");
    all.AddRange(args);
    start.Arguments = GitJoinArgs(all);
    start.WorkingDirectory = repo;
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    start.StandardOutputEncoding = GitEncoding;
    start.StandardErrorEncoding = GitEncoding;
    // 不设 GIT_TERMINAL_PROMPT：fetch/push 需要凭据时会永久挂住，把线程池拖死
    try { start.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0"; } catch (Exception) { }
    try { start.EnvironmentVariables["GIT_OPTIONAL_LOCKS"] = "0"; } catch (Exception) { }

    Process process;
    try {
      process = Process.Start(start);
    } catch (Exception ex) {
      result.code = -1;
      result.stderr = ex.Message;
      return result;
    }
    if (process == null) {
      result.code = -1;
      result.stderr = "无法启动 git.exe";
      return result;
    }

    GitStream outStream = new GitStream();
    GitStream errStream = new GitStream();
    Thread outThread = new Thread(delegate() { GitReadInto(process.StandardOutput, outStream); });
    Thread errThread = new Thread(delegate() { GitReadInto(process.StandardError, errStream); });
    outThread.IsBackground = true;
    errThread.IsBackground = true;
    outThread.Start();
    errThread.Start();

    bool exited = false;
    try { exited = process.WaitForExit(timeoutMs); } catch (Exception) { }
    if (!exited) {
      result.timeout = true;
      GitKillTree(process);
      try { process.WaitForExit(3000); } catch (Exception) { }
    }
    outThread.Join(5000);
    errThread.Join(5000);

    result.stdout = outStream.text.ToString();
    result.stderr = errStream.text.ToString();
    result.truncated = outStream.truncated || errStream.truncated;
    try { result.code = process.ExitCode; } catch (Exception) { result.code = -1; }
    try { process.Dispose(); } catch (Exception) { }
    if (result.timeout) {
      result.stderr = (result.stderr + "\n命令超时（" + (timeoutMs / 1000) + " 秒），已终止。").Trim();
    }
    return result;
  }

  static bool GitIsNetOp(string op) {
    for (int i = 0; i < GitNetOps.Length; i++) {
      if (string.Equals(GitNetOps[i], op, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }

  // 提交说明 / 标签说明写临时文件走 -F，绕开多行文本与引号的转义问题
  static string GitMessageFile(string message) {
    string dir = Path.Combine(Path.GetTempPath(), "wb-git");
    Directory.CreateDirectory(dir);
    string path = Path.Combine(dir, "msg-" + Guid.NewGuid().ToString("N") + ".txt");
    File.WriteAllText(path, message, GitEncoding);
    return path;
  }

  // ---- 扫描 ----

  static string GitScanJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    List<Dictionary<string, object>> repos = new List<Dictionary<string, object>>();
    bool truncated = false;
    for (int i = 0; i < roots.Count; i++) {
      GitScanRoot(roots[i], roots[i], repos, ref truncated);
    }
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = true;
    result["roots"] = roots;
    result["repos"] = repos;
    result["truncated"] = truncated;
    return GitJson(result);
  }

  // 只做文件系统判断、不调 git；命中仓库就不再往下钻，避免子模块/嵌套仓库重复出现
  static void GitScanRoot(string start, string root, List<Dictionary<string, object>> repos, ref bool truncated) {
    Queue<string[]> queue = new Queue<string[]>();
    queue.Enqueue(new string[] { start, "0" });
    while (queue.Count > 0) {
      if (repos.Count >= GitScanLimit) { truncated = true; return; }
      string[] item = queue.Dequeue();
      string dir = item[0];
      int level = Convert.ToInt32(item[1]);
      if (GitIsRepo(dir)) {
        Dictionary<string, object> repo = new Dictionary<string, object>();
        repo["path"] = dir;
        string name = Path.GetFileName(dir);
        repo["name"] = name.Length > 0 ? name : dir;
        repo["root"] = root;
        repos.Add(repo);
        continue;
      }
      if (level >= GitScanDepth) continue;
      string[] children;
      try { children = Directory.GetDirectories(dir); } catch (Exception) { continue; }
      for (int i = 0; i < children.Length; i++) {
        string child = children[i];
        string name = Path.GetFileName(child);
        if (name.Length == 0 || name[0] == '.') continue;
        bool skip = false;
        for (int j = 0; j < GitSkipDirs.Length; j++) {
          if (string.Equals(GitSkipDirs[j], name, StringComparison.OrdinalIgnoreCase)) { skip = true; break; }
        }
        if (skip) continue;
        try {
          FileAttributes attrs = File.GetAttributes(child);
          if ((attrs & FileAttributes.Hidden) != 0) continue;
          if ((attrs & FileAttributes.System) != 0) continue;
          if ((attrs & FileAttributes.ReparsePoint) != 0) continue;   // 跳过符号链接，防止绕圈
        } catch (Exception) {
          continue;
        }
        queue.Enqueue(new string[] { child, Convert.ToString(level + 1) });
      }
    }
  }

  // ---- 状态 ----

  static string GitStatusJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    ArrayList raw = payload.ContainsKey("repos") ? payload["repos"] as ArrayList : null;
    List<string> repos = new List<string>();
    List<Dictionary<string, object>> failed = new List<Dictionary<string, object>>();
    if (raw != null) {
      foreach (object item in raw) {
        string error;
        string repo = GitRepo(roots, Convert.ToString(item), out error);
        if (error.Length > 0) {
          Dictionary<string, object> bad = new Dictionary<string, object>();
          bad["path"] = Convert.ToString(item);
          bad["error"] = error;
          failed.Add(bad);
          continue;
        }
        repos.Add(repo);
      }
    }

    Dictionary<string, object>[] results = new Dictionary<string, object>[repos.Count];
    object gate = new object();
    int cursor = -1;
    int remaining = Math.Min(GitParallel, repos.Count);
    ManualResetEvent done = new ManualResetEvent(remaining == 0);
    for (int w = 0; w < remaining; w++) {
      Thread worker = new Thread(delegate() {
        while (true) {
          int index;
          lock (gate) { index = ++cursor; }
          if (index >= repos.Count) break;
          results[index] = GitRepoStatus(repos[index]);
        }
        lock (gate) {
          if (--remaining == 0) done.Set();
        }
      });
      worker.IsBackground = true;
      worker.Start();
    }
    done.WaitOne();

    List<object> list = new List<object>();
    for (int i = 0; i < repos.Count; i++) {
      if (results[i] != null) list.Add(results[i]);
    }
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = true;
    result["repos"] = list;
    result["failed"] = failed;
    return GitJson(result);
  }

  static Dictionary<string, object> GitRepoStatus(string repo) {
    Dictionary<string, object> item = new Dictionary<string, object>();
    item["path"] = repo;
    string name = Path.GetFileName(repo);
    item["name"] = name.Length > 0 ? name : repo;

    List<string> args = new List<string>();
    args.Add("status");
    args.Add("--porcelain=v1");
    args.Add("-z");
    args.Add("-b");
    args.Add("--untracked-files=all");
    GitRun run = RunGit(repo, args, GitReadTimeout);

    if (run.timeout || (run.code != 0 && run.stdout.Length == 0)) {
      item["error"] = run.timeout ? "命令超时" : GitFirstLine(run.stderr, "git status 失败");
      item["branch"] = "";
      item["files"] = new List<object>();
      item["staged"] = 0;
      item["unstaged"] = 0;
      item["clean"] = true;
      item["last"] = null;
      item["empty"] = false;
      item["remoteUrl"] = "";
      return item;
    }

    string branch = "";
    string upstream = "";
    bool detached = false;
    int ahead = 0;
    int behind = 0;
    List<object> files = new List<object>();
    int stagedCount = 0;
    int unstagedCount = 0;

    string[] records = run.stdout.Split('\0');
    for (int i = 0; i < records.Length; i++) {
      string record = records[i];
      if (record.Length == 0) continue;
      if (record[0] == '#' && record.Length > 2 && record[1] == '#') {
        string header = record.Substring(2).Trim();
        int bracket = header.IndexOf(" [");
        if (bracket >= 0) {
          string counts = header.Substring(bracket + 2).TrimEnd(']');
          header = header.Substring(0, bracket).Trim();
          MatchCollection matches = Regex.Matches(counts, "(ahead|behind)\\s+(\\d+)");
          for (int m = 0; m < matches.Count; m++) {
            int value = Convert.ToInt32(matches[m].Groups[2].Value);
            if (string.Equals(matches[m].Groups[1].Value, "ahead", StringComparison.Ordinal)) ahead = value;
            else behind = value;
          }
        }
        int dots = header.IndexOf("...");
        if (dots >= 0) {
          upstream = header.Substring(dots + 3).Trim();
          header = header.Substring(0, dots);
        }
        header = header.Trim();
        if (header.StartsWith("HEAD", StringComparison.Ordinal)) {
          detached = true;
          branch = "HEAD";
        } else if (header.StartsWith("No commits yet", StringComparison.OrdinalIgnoreCase)) {
          branch = "";
        } else {
          branch = header;
        }
        continue;
      }
      if (record.Length < 3) continue;
      string code = record.Substring(0, 2);
      string filePath = record.Substring(3);
      string original = "";
      if ((code[0] == 'R' || code[0] == 'C') && i + 1 < records.Length) {
        original = records[i + 1];
        i++;
      }
      bool untracked = code == "??";
      bool ignore = code == "!!";
      if (ignore) continue;
      bool isStaged = !untracked && code[0] != ' ' && code[0] != '?';
      bool isUnstaged = untracked || (code[1] != ' ' && code[1] != '?');
      if (isStaged) stagedCount++;
      if (isUnstaged) unstagedCount++;
      Dictionary<string, object> file = new Dictionary<string, object>();
      file["path"] = filePath;
      file["code"] = code;
      file["index"] = code.Substring(0, 1);
      file["worktree"] = code.Substring(1, 1);
      file["staged"] = isStaged;
      file["unstaged"] = isUnstaged;
      file["untracked"] = untracked;
      file["orig"] = original;
      files.Add(file);
    }

    item["branch"] = branch;
    item["upstream"] = upstream;
    item["detached"] = detached;
    item["ahead"] = ahead;
    item["behind"] = behind;
    item["files"] = files;
    item["staged"] = stagedCount;
    item["unstaged"] = unstagedCount;
    item["clean"] = stagedCount + unstagedCount == 0;
    item["error"] = "";

    // 远端地址：界面用它显示"推到哪里"，没配就是空（首次推送前必须先设置）
    List<string> remoteArgs = new List<string>();
    remoteArgs.Add("config");
    remoteArgs.Add("--get");
    remoteArgs.Add("remote.origin.url");
    GitRun remote = RunGit(repo, remoteArgs, GitReadTimeout);
    item["remoteUrl"] = (!remote.timeout && remote.code == 0) ? remote.stdout.Trim() : "";

    List<string> logArgs = new List<string>();
    logArgs.Add("log");
    logArgs.Add("-1");
    logArgs.Add("--format=%h%x1f%an%x1f%at%x1f%s");
    GitRun log = RunGit(repo, logArgs, GitReadTimeout);
    Dictionary<string, object> last = null;
    if (!log.timeout && log.code == 0) {
      string[] parts = log.stdout.Trim().Split('\u001f');
      if (parts.Length >= 4) {
        last = new Dictionary<string, object>();
        last["hash"] = parts[0];
        last["author"] = parts[1];
        last["at"] = parts[2];
        last["subject"] = parts[3];
      }
    }
    item["last"] = last;
    item["empty"] = last == null;
    return item;
  }

  // ---- 历史 ----

  static string GitLogJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    string error;
    string repo = GitRepo(roots, ValueOf(payload, "repo"), out error);
    if (error.Length > 0) return GitJson(GitFail("", error));

    int limit = GitInt(payload, "limit", 50, 1, GitLogMax);
    int skip = GitInt(payload, "skip", 0, 0, 100000);
    string refName = ValueOf(payload, "ref").Trim();
    if (refName.Length > 0 && !SafeGitRef(refName)) return GitJson(GitFail(repo, "分支或提交名不合法"));

    List<string> args = new List<string>();
    args.Add("log");
    args.Add("--max-count=" + limit);
    if (skip > 0) args.Add("--skip=" + skip);
    args.Add("--format=%h%x1f%H%x1f%an%x1f%at%x1f%s");
    if (refName.Length > 0) args.Add(refName);
    args.Add("--");

    GitRun run = RunGit(repo, args, GitReadTimeout);
    Dictionary<string, object> result = GitResult(repo, run);
    List<object> commits = new List<object>();
    if (!run.timeout && run.code == 0) {
      string[] lines = run.stdout.Replace("\r\n", "\n").Split('\n');
      for (int i = 0; i < lines.Length; i++) {
        string line = lines[i].Trim();
        if (line.Length == 0) continue;
        string[] parts = line.Split('\u001f');
        if (parts.Length < 5) continue;
        Dictionary<string, object> commit = new Dictionary<string, object>();
        commit["hash"] = parts[0];
        commit["full"] = parts[1];
        commit["author"] = parts[2];
        commit["at"] = parts[3];
        commit["subject"] = parts[4];
        commits.Add(commit);
      }
    }
    result["commits"] = commits;
    result["hasMore"] = commits.Count >= limit;
    return GitJson(result);
  }

  // ---- 差异 ----

  static string GitDiffJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    string error;
    string repo = GitRepo(roots, ValueOf(payload, "repo"), out error);
    if (error.Length > 0) return GitJson(GitFail("", error));

    string scope = ValueOf(payload, "scope").Trim().ToLowerInvariant();
    string filePath = ValueOf(payload, "path").Trim();
    string refName = ValueOf(payload, "ref").Trim();

    List<string> args = new List<string>();
    if (scope == "commit") {
      if (!SafeGitRef(refName)) return GitJson(GitFail(repo, "提交号不合法"));
      args.Add("show");
      args.Add("--patch");
      args.Add("--format=");
      args.Add("--no-color");
      args.Add(refName);
    } else {
      args.Add("diff");
      args.Add("--no-color");
      if (scope == "staged") args.Add("--cached");
    }
    if (filePath.Length > 0) {
      string safe = SafeRepoPath(filePath);
      if (safe == null) return GitJson(GitFail(repo, "文件路径不合法"));
      args.Add("--");
      args.Add(safe);
    }

    GitRun run = RunGit(repo, args, GitReadTimeout);
    Dictionary<string, object> result = GitResult(repo, run);
    result["scope"] = scope;
    result["path"] = filePath;
    return GitJson(result);
  }

  // ---- 分支 / 标签 ----

  static string GitBranchesJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    string error;
    string repo = GitRepo(roots, ValueOf(payload, "repo"), out error);
    if (error.Length > 0) return GitJson(GitFail("", error));

    // 注意：for-each-ref 的 --format 不支持 %x1f 这类十六进制转义（会原样输出），
    // 所以这里用字面制表符当字段分隔符；refname / upstream 都不允许含空白，分隔是安全的。
    List<string> args = new List<string>();
    args.Add("for-each-ref");
    args.Add("--format=%(refname)\t%(refname:short)\t%(committerdate:unix)\t%(subject)");
    args.Add("--sort=-committerdate");
    args.Add("refs/heads");
    args.Add("refs/remotes");
    GitRun run = RunGit(repo, args, GitReadTimeout);
    Dictionary<string, object> result = GitResult(repo, run);

    List<object> local = new List<object>();
    List<object> remote = new List<object>();
    if (!run.timeout && run.code == 0) {
      string[] lines = run.stdout.Replace("\r\n", "\n").Split('\n');
      for (int i = 0; i < lines.Length; i++) {
        string line = lines[i].Trim();
        if (line.Length == 0) continue;
        string[] parts = line.Split('\t');
        if (parts.Length < 3) continue;
        string full = parts[0];
        if (full.EndsWith("/HEAD", StringComparison.OrdinalIgnoreCase)) continue;
        Dictionary<string, object> branch = new Dictionary<string, object>();
        branch["ref"] = full;
        branch["name"] = parts[1];
        branch["at"] = parts[2];
        branch["subject"] = GitRest(parts, 3);
        if (full.StartsWith("refs/heads/", StringComparison.OrdinalIgnoreCase)) local.Add(branch);
        else if (full.StartsWith("refs/remotes/", StringComparison.OrdinalIgnoreCase)) remote.Add(branch);
      }
    }

    List<string> headArgs = new List<string>();
    headArgs.Add("rev-parse");
    headArgs.Add("--abbrev-ref");
    headArgs.Add("HEAD");
    GitRun head = RunGit(repo, headArgs, GitReadTimeout);
    string current = head.code == 0 ? head.stdout.Trim() : "";
    if (current == "HEAD") current = "";

    result["local"] = local;
    result["remote"] = remote;
    result["current"] = current;
    return GitJson(result);
  }

  static string GitTagsJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    string error;
    string repo = GitRepo(roots, ValueOf(payload, "repo"), out error);
    if (error.Length > 0) return GitJson(GitFail("", error));

    List<string> args = new List<string>();
    args.Add("for-each-ref");
    args.Add("--format=%(refname:short)\t%(objectname:short)\t%(creatordate:unix)\t%(subject)");
    args.Add("--sort=-creatordate");
    args.Add("refs/tags");
    GitRun run = RunGit(repo, args, GitReadTimeout);
    Dictionary<string, object> result = GitResult(repo, run);

    List<object> tags = new List<object>();
    if (!run.timeout && run.code == 0) {
      string[] lines = run.stdout.Replace("\r\n", "\n").Split('\n');
      for (int i = 0; i < lines.Length; i++) {
        string line = lines[i].Trim();
        if (line.Length == 0) continue;
        string[] parts = line.Split('\t');
        if (parts.Length < 3) continue;
        Dictionary<string, object> tag = new Dictionary<string, object>();
        tag["name"] = parts[0];
        tag["hash"] = parts[1];
        tag["at"] = parts[2];
        tag["subject"] = GitRest(parts, 3);
        tags.Add(tag);
      }
    }
    result["tags"] = tags;
    return GitJson(result);
  }

  // ---- 写操作 ----

  static string GitExecJson(Dictionary<string, object> payload) {
    List<string> roots = GitRoots(payload);
    string error;
    string repo = GitRepo(roots, ValueOf(payload, "repo"), out error);
    if (error.Length > 0) return GitJson(GitFail("", error));

    string op = ValueOf(payload, "op").Trim();
    if (op.Equals("remote-set", StringComparison.OrdinalIgnoreCase)) return GitRemoteSet(repo, payload);

    string[] template = GitOps.ContainsKey(op) ? GitOps[op] : null;
    if (template == null) return GitJson(GitFail(repo, "不支持的动作：" + (op.Length > 0 ? op : "(空)")));

    string message = ValueOf(payload, "message");
    string messageFile = "";
    List<string> args = new List<string>();
    try {
      for (int i = 0; i < template.Length; i++) {
        string token = template[i];
        if (token == "{paths}") {
          ArrayList paths = payload.ContainsKey("paths") ? payload["paths"] as ArrayList : null;
          if (paths == null || paths.Count == 0) return GitJson(GitFail(repo, "没有选中任何文件"));
          if (paths.Count > 500) return GitJson(GitFail(repo, "一次最多操作 500 个文件"));
          for (int p = 0; p < paths.Count; p++) {
            string safe = SafeRepoPath(Convert.ToString(paths[p]));
            if (safe == null) return GitJson(GitFail(repo, "文件路径不合法：" + Convert.ToString(paths[p])));
            args.Add(safe);
          }
          continue;
        }
        if (token == "{ref}") {
          string refName = ValueOf(payload, "ref").Trim();
          if (!SafeGitRef(refName)) return GitJson(GitFail(repo, "分支或提交名不合法"));
          args.Add(refName);
          continue;
        }
        if (token == "{name}") {
          string name = ValueOf(payload, "name").Trim();
          if (!SafeGitName(name)) return GitJson(GitFail(repo, "名称不合法（不能以 - 开头，不能含空格）"));
          args.Add(name);
          continue;
        }
        if (token == "{msgfile}") {
          if (message.Trim().Length == 0) return GitJson(GitFail(repo, "说明不能为空"));
          if (message.Length > 20000) return GitJson(GitFail(repo, "说明太长了"));
          messageFile = GitMessageFile(message);
          args.Add(messageFile);
          continue;
        }
        args.Add(token);
      }

      GitRun run = RunGit(repo, args, GitIsNetOp(op) ? GitNetTimeout : GitReadTimeout);
      Dictionary<string, object> result = GitResult(repo, run);
      result["op"] = op;
      result["command"] = "git " + GitJoinArgs(args);
      return GitJson(result);
    } finally {
      if (messageFile.Length > 0) {
        try { if (File.Exists(messageFile)) File.Delete(messageFile); } catch (Exception) { }
      }
    }
  }

  // 远端地址校验：允许常见 URL 形式，以及本机路径 / 网络共享（离线备份到别的盘或 NAS 是合理用法）。
  // 一律拒绝：空、超长、以 - 开头（会被 git 当成选项）、含引号或控制字符。
  // 空格是允许的——参数在 GitQuote 里已经正确加了引号。
  static bool SafeGitRemoteUrl(string url) {
    if (string.IsNullOrEmpty(url) || url.Length > 300) return false;
    if (url[0] == '-') return false;
    for (int i = 0; i < url.Length; i++) {
      char c = url[i];
      if (c == '"' || c == '\'' || c == '\t' || c == '\r' || c == '\n') return false;
      if (c < ' ') return false;
    }
    string[] prefixes = new string[] { "http://", "https://", "ssh://", "git://", "git@" };
    for (int i = 0; i < prefixes.Length; i++) {
      if (url.StartsWith(prefixes[i], StringComparison.OrdinalIgnoreCase)) return true;
    }
    // 本机绝对路径（D:\... 或 D:/...）与 UNC（\\server\share\...）
    if (url.Length >= 3 && url[1] == ':' && (url[2] == '\\' || url[2] == '/')) return true;
    if (url.StartsWith("\\\\", StringComparison.Ordinal)) return true;
    return false;
  }

  // 设置 origin：已有就改地址，没有就新建。首次推送靠这一步。
  static string GitRemoteSet(string repo, Dictionary<string, object> payload) {
    string url = ValueOf(payload, "url").Trim();
    if (!SafeGitRemoteUrl(url)) {
      return GitJson(GitFail(repo, "远端地址不合法：填 http(s)://、ssh://、git://、git@主机:路径，或本机/共享路径（如 D:\\repo.git）"));
    }
    List<string> probeArgs = new List<string>();
    probeArgs.Add("remote");
    probeArgs.Add("get-url");
    probeArgs.Add("origin");
    GitRun probe = RunGit(repo, probeArgs, GitReadTimeout);
    bool exists = !probe.timeout && probe.code == 0 && probe.stdout.Trim().Length > 0;

    List<string> args = new List<string>();
    args.Add("remote");
    args.Add(exists ? "set-url" : "add");
    args.Add("origin");
    args.Add(url);
    GitRun run = RunGit(repo, args, GitReadTimeout);
    Dictionary<string, object> result = GitResult(repo, run);
    result["op"] = "remote-set";
    result["action"] = exists ? "set-url" : "add";
    result["remoteUrl"] = url;
    result["command"] = "git remote " + (exists ? "set-url" : "add") + " origin " + url;
    return GitJson(result);
  }

  static string ReadVersionIniJson() {
    string path = ResolveIniPath();
    bool exists = path.Length > 0 && File.Exists(path);
    List<Dictionary<string, object>> projects = new List<Dictionary<string, object>>();
    if (exists) projects = ParseIni(File.ReadAllText(path, IniEncoding));
    Dictionary<string, object> root = new Dictionary<string, object>();
    root["projects"] = projects;
    root["iniPath"] = path;
    root["exists"] = exists;
    root["configured"] = path.Length > 0;
    return new JavaScriptSerializer().Serialize(root);
  }

  static string WriteVersionIni(string body) {
    JavaScriptSerializer serializer = new JavaScriptSerializer();
    Dictionary<string, object> root;
    try {
      root = serializer.Deserialize<Dictionary<string, object>>(body);
    } catch (Exception) {
      return "invalid json";
    }
    if (root == null || !root.ContainsKey("projects")) return "missing projects";
    ArrayList list = root["projects"] as ArrayList;
    if (list == null) return "missing projects";
    List<Dictionary<string, object>> projects = new List<Dictionary<string, object>>();
    foreach (object item in list) {
      Dictionary<string, object> project = item as Dictionary<string, object>;
      if (project == null) return "bad project";
      string section = ValueOf(project, "section").Trim();
      if (section.Length == 0 || section.IndexOfAny(new char[] { '[', ']', '\r', '\n', '=' }) >= 0) return "bad section";
      string name = ValueOf(project, "name").Trim();
      string mims = ValueOf(project, "mimsConfigPath").Trim();
      if (name.IndexOfAny(new char[] { '\r', '\n' }) >= 0 || mims.IndexOfAny(new char[] { '\r', '\n' }) >= 0) return "bad text";
      ArrayList copies = project.ContainsKey("copies") ? project["copies"] as ArrayList : null;
      if (copies == null) return "bad copies";
      foreach (object copyObj in copies) {
        Dictionary<string, object> copy = copyObj as Dictionary<string, object>;
        if (copy == null) return "bad copy";
        string source = ValueOf(copy, "source");
        string target = ValueOf(copy, "target");
        if (source.IndexOfAny(new char[] { '\r', '\n' }) >= 0 || target.IndexOfAny(new char[] { '\r', '\n' }) >= 0) return "bad path";
      }
      projects.Add(project);
    }
    if (projects.Count == 0) return "empty";
    string text = RenderIni(projects);
    try {
      string target = ResolveIniPath();
      if (target.Length == 0) return "还没有设置配置文件位置";
      // 防止用户把路径指到别的文件上，一次保存就把它覆盖掉
      if (!string.Equals(Path.GetExtension(target), ".ini", StringComparison.OrdinalIgnoreCase)) return "配置文件必须是 .ini";
      string dir = Path.GetDirectoryName(target);
      if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
      File.WriteAllText(target, text, IniEncoding);
    } catch (Exception ex) {
      return ex.Message;
    }
    return null;
  }

  static string ValueOf(Dictionary<string, object> item, string key) {
    if (!item.ContainsKey(key) || item[key] == null) return "";
    return Convert.ToString(item[key]);
  }

  static bool Truthy(Dictionary<string, object> item, string key) {
    if (!item.ContainsKey(key) || item[key] == null) return false;
    object value = item[key];
    if (value is bool) return (bool)value;
    string text = Convert.ToString(value).Trim().ToLowerInvariant();
    return text == "true" || text == "1" || text == "yes";
  }

  /* ===== 内置发布 =====
     等价于 Update_Version_Software.exe：按 CopyN.Source/Target 复制（目录递归），
     大小 + 修改时间都一致就跳过，某个项目有文件变化才把 Mims 配置里的版本号末位 +1。
     区别只有两处：支持 dryRun 预览，以及单个复制项失败不会中断其余项目。 */

  const int PublishDetailLimit = 200;

  sealed class PublishItem {
    public string source = "";
    public string target = "";
    public string status = "skip";
    public string detail = "";
    public string error = "";
    public int files = 0;
  }

  sealed class PublishProject {
    public string section = "";
    public string name = "";
    public string mimsPath = "";
    public bool changed = false;
    public string oldVersion = "";
    public string newVersion = "";
    public string note = "";
    public string error = "";
    public List<PublishItem> items = new List<PublishItem>();
  }

  static string PublishError(string message) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = false;
    result["error"] = message;
    result["aborted"] = false;
    result["abortAt"] = "";
    result["iniPath"] = ResolveIniPath();
    result["dryRun"] = false;
    result["projects"] = new List<object>();
    result["updated"] = new List<string>();
    result["failed"] = new List<string>();
    result["truncated"] = false;
    Dictionary<string, object> totals = new Dictionary<string, object>();
    totals["updated"] = 0;
    totals["skipped"] = 0;
    totals["failed"] = 0;
    totals["projects"] = 0;
    result["totals"] = totals;
    return new JavaScriptSerializer().Serialize(result);
  }

  static string PublishFromJson(string body) {
    Dictionary<string, object> request;
    try {
      request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body == null ? "" : body);
    } catch (Exception) {
      return PublishError("请求格式不正确");
    }
    if (request == null) return PublishError("请求格式不正确");

    bool dryRun = Truthy(request, "dryRun");
    string only = ValueOf(request, "section").Trim();

    string iniPath = ResolveIniPath();
    if (iniPath.Length == 0) return PublishError("还没有设置配置文件位置，请先在页面上点「更改…」指定");
    if (!File.Exists(iniPath)) return PublishError("找不到 UpdateVersion.ini：" + iniPath);

    List<Dictionary<string, object>> configs;
    string iniText;
    try {
      iniText = File.ReadAllText(iniPath, IniEncoding);
      configs = ParseIni(iniText);
    } catch (Exception ex) {
      return PublishError("读取 UpdateVersion.ini 失败：" + ex.Message);
    }
    if (configs.Count == 0) return PublishError("ini 里没有任何配置节：" + iniPath);
    // 旧的 SourcePath / TargetPath 写法解析器不认识，宁可明确报错也不要静默漏做
    if (Regex.IsMatch(iniText, "(?im)^\\s*(SourcePath|TargetPath)\\s*=")) {
      return PublishError("检测到旧的 SourcePath / TargetPath 写法。请先在页面上保存一次，把它转成 CopyN.Source / CopyN.Target 再发布。");
    }

    List<PublishProject> projects = new List<PublishProject>();
    List<string> updated = new List<string>();
    List<string> failed = new List<string>();
    int copied = 0;
    int skipped = 0;
    bool truncated = false;
    bool aborted = false;
    string abortMessage = "";
    string abortAt = "";

    for (int i = 0; i < configs.Count && !aborted; i++) {
      Dictionary<string, object> config = configs[i];
      string section = ValueOf(config, "section").Trim();
      if (only.Length > 0 && !string.Equals(section, only, StringComparison.OrdinalIgnoreCase)) continue;

      PublishProject project = new PublishProject();
      project.section = section;
      project.name = ValueOf(config, "name").Trim();
      project.mimsPath = ValueOf(config, "mimsConfigPath").Trim();

      ArrayList copies = config.ContainsKey("copies") ? config["copies"] as ArrayList : null;
      if (copies == null || copies.Count == 0) {
        project.note = "这个节没有复制项，未做任何事";
        projects.Add(project);
        continue;
      }

      for (int j = 0; j < copies.Count && !aborted; j++) {
        Dictionary<string, object> copy = copies[j] as Dictionary<string, object>;
        if (copy == null) continue;
        PublishItem item = new PublishItem();
        item.source = ValueOf(copy, "source").Trim();
        item.target = ValueOf(copy, "target").Trim();
        if (item.source.Length == 0 || item.target.Length == 0) {
          item.status = "error";
          item.error = "Copy" + (j + 1) + " 需要同时配置 Source 和 Target";
          aborted = true;
          abortMessage = item.error;
          abortAt = section + " · Copy" + (j + 1);
          failed.Add(abortAt + "：" + item.error);
          project.items.Add(item);
          break;
        }
        try {
          RunPublishCopy(item, dryRun, updated, ref copied, ref skipped, ref truncated);
        } catch (Exception ex) {
          item.status = "error";
          item.error = ex.Message;
          aborted = true;
          abortMessage = ex.Message;
          abortAt = section + " · " + item.source;
          failed.Add(item.source + " -> " + item.target + "：" + ex.Message);
        }
        if (item.status == "copy") project.changed = true;
        project.items.Add(item);
      }

      if (!aborted && project.changed) {
        if (project.mimsPath.Length == 0) {
          project.note = "文件有更新，但没有配置 MimsConfigPath，跳过版本号递增";
        } else {
          try {
            BumpXmlVersion(project.mimsPath, dryRun, out project.oldVersion, out project.newVersion);
          } catch (Exception ex) {
            project.error = ex.Message;
            aborted = true;
            abortMessage = (project.name.Length > 0 ? project.name : section) + " 更新版本失败：" + ex.Message;
            abortAt = project.mimsPath;
            failed.Add(project.mimsPath + "：" + ex.Message);
          }
        }
      } else if (!aborted) {
        project.note = "文件一致，无需更新";
      }

      projects.Add(project);
    }

    if (only.Length > 0 && projects.Count == 0) return PublishError("ini 里没有配置节：" + only);

    Dictionary<string, object> result = new Dictionary<string, object>();
    result["ok"] = true;
    result["error"] = aborted ? abortMessage : "";
    result["aborted"] = aborted;
    result["abortAt"] = aborted ? abortAt : "";
    result["iniPath"] = iniPath;
    result["dryRun"] = dryRun;
    Dictionary<string, object> summary = new Dictionary<string, object>();
    summary["updated"] = copied;
    summary["skipped"] = skipped;
    summary["failed"] = failed.Count;
    summary["projects"] = projects.Count;
    result["totals"] = summary;
    result["projects"] = projects;
    result["updated"] = updated;
    result["failed"] = failed;
    result["truncated"] = truncated;
    return new JavaScriptSerializer().Serialize(result);
  }

  static void RunPublishCopy(PublishItem item, bool dryRun, List<string> updated, ref int copied, ref int skipped, ref bool truncated) {
    if (Directory.Exists(item.source)) {
      int changed = 0;
      int same = 0;
      CopyTree(item.source, item.target, dryRun, updated, ref changed, ref same, ref truncated);
      copied += changed;
      skipped += same;
      item.files = changed + same;
      item.status = changed > 0 ? "copy" : "skip";
      item.detail = "目录：共 " + item.files + " 个文件，需更新 " + changed + " 个，已是最新 " + same + " 个";
      return;
    }
    if (!File.Exists(item.source)) throw new Exception("源路径不存在");

    string destination = item.target;
    if (Directory.Exists(item.target)) destination = Path.Combine(item.target, Path.GetFileName(item.source));
    item.target = destination;

    string reason = CompareForPublish(item.source, destination);
    if (reason.Length == 0) {
      item.status = "skip";
      item.detail = "大小和修改时间一致，无需复制";
      skipped++;
      return;
    }

    if (!dryRun) {
      string parent = Path.GetDirectoryName(destination);
      if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) Directory.CreateDirectory(parent);
      File.Copy(item.source, destination, true);
    }
    item.status = "copy";
    item.detail = reason;
    copied++;
    if (updated.Count < PublishDetailLimit) updated.Add(item.source + " -> " + destination);
    else truncated = true;
  }

  static string CompareForPublish(string source, string destination) {
    if (!File.Exists(destination)) return "目标不存在，需要复制";
    if (Directory.Exists(destination)) return "目标是目录，需要复制";
    FileInfo src = new FileInfo(source);
    FileInfo dst = new FileInfo(destination);
    if (src.Length != dst.Length) {
      return "大小不一致（源 " + src.Length + " 字节，目标 " + dst.Length + " 字节）";
    }
    if (src.LastWriteTimeUtc != dst.LastWriteTimeUtc) {
      return "修改时间不一致（源 " + src.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm:ss")
        + "，目标 " + dst.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm:ss") + "）";
    }
    return "";
  }

  static void CopyTree(string sourceDir, string targetDir, bool dryRun, List<string> updated,
                       ref int changed, ref int same, ref bool truncated) {
    if (!dryRun && !Directory.Exists(targetDir)) Directory.CreateDirectory(targetDir);
    string[] entries;
    try {
      entries = Directory.GetFileSystemEntries(sourceDir);
    } catch (Exception ex) {
      throw new Exception("遍历目录失败：" + ex.Message);
    }
    for (int i = 0; i < entries.Length; i++) {
      string child = entries[i];
      string targetChild = Path.Combine(targetDir, Path.GetFileName(child));
      if (Directory.Exists(child)) {
        CopyTree(child, targetChild, dryRun, updated, ref changed, ref same, ref truncated);
        continue;
      }
      string reason = CompareForPublish(child, targetChild);
      if (reason.Length == 0) {
        same++;
        continue;
      }
      if (!dryRun) {
        string parent = Path.GetDirectoryName(targetChild);
        if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) Directory.CreateDirectory(parent);
        File.Copy(child, targetChild, true);
      }
      changed++;
      if (updated.Count < PublishDetailLimit) updated.Add(child + " -> " + targetChild);
      else truncated = true;
    }
  }

  // 按字节替换 Version="x.y.z" 的末位，避免猜错 xml 的编码
  static void BumpXmlVersion(string xmlPath, bool dryRun, out string oldVersion, out string newVersion) {
    oldVersion = "";
    newVersion = "";
    if (!File.Exists(xmlPath)) throw new Exception("Mims 配置文件不存在");

    byte[] bytes = File.ReadAllBytes(xmlPath);
    string raw = RawEncoding.GetString(bytes);
    Match match = Regex.Match(raw, "Version\\s*=\\s*\"([^\"]+)\"");
    if (!match.Success) throw new Exception("在 xml 中未找到 Version 属性");

    oldVersion = match.Groups[1].Value;
    newVersion = BumpLastNumber(oldVersion);
    if (dryRun) return;

    string replaced = raw.Substring(0, match.Index) + "Version=\"" + newVersion + "\""
      + raw.Substring(match.Index + match.Length);
    File.WriteAllBytes(xmlPath, RawEncoding.GetBytes(replaced));
  }

  static string BumpLastNumber(string version) {
    string[] parts = version.Split('.');
    if (parts.Length == 0) throw new Exception("Version 格式无效：" + version);
    string last = parts[parts.Length - 1];
    if (last.Length == 0) throw new Exception("Version 最后一段不是数字：" + version);
    for (int i = 0; i < last.Length; i++) {
      if (!char.IsDigit(last[i])) throw new Exception("Version 最后一段不是数字：" + version);
    }
    long value;
    if (!long.TryParse(last, out value)) throw new Exception("Version 最后一段不是数字：" + version);
    parts[parts.Length - 1] = (value + 1).ToString();
    return string.Join(".", parts);
  }

  static List<Dictionary<string, object>> ParseIni(string text) {
    List<Dictionary<string, object>> projects = new List<Dictionary<string, object>>();
    Dictionary<string, object> current = null;
    Dictionary<int, Dictionary<string, string>> copies = null;
    string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
    for (int i = 0; i < lines.Length; i++) {
      string line = lines[i].Trim();
      if (line.Length == 0 || line[0] == ';' || line[0] == '#') continue;
      if (line[0] == '[' && line[line.Length - 1] == ']') {
        FlushCopies(current, copies);
        current = new Dictionary<string, object>();
        current["section"] = line.Substring(1, line.Length - 2).Trim();
        current["name"] = "";
        current["mimsConfigPath"] = "";
        copies = new Dictionary<int, Dictionary<string, string>>();
        projects.Add(current);
        continue;
      }
      if (current == null) continue;
      int eq = line.IndexOf('=');
      if (eq <= 0) continue;
      string key = line.Substring(0, eq).Trim();
      string value = line.Substring(eq + 1).Trim();
      if (key.Equals("Name", StringComparison.OrdinalIgnoreCase)) current["name"] = value;
      else if (key.Equals("MimsConfigPath", StringComparison.OrdinalIgnoreCase)) current["mimsConfigPath"] = value;
      else {
        int index;
        bool isSource;
        if (TryCopyKey(key, out index, out isSource)) {
          Dictionary<string, string> pair;
          if (!copies.TryGetValue(index, out pair)) {
            pair = new Dictionary<string, string>();
            pair["source"] = "";
            pair["target"] = "";
            copies[index] = pair;
          }
          pair[isSource ? "source" : "target"] = value;
        }
      }
    }
    FlushCopies(current, copies);
    return projects;
  }

  static void FlushCopies(Dictionary<string, object> current, Dictionary<int, Dictionary<string, string>> copies) {
    if (current == null || copies == null) return;
    List<int> keys = new List<int>(copies.Keys);
    keys.Sort();
    ArrayList list = new ArrayList();
    for (int i = 0; i < keys.Count; i++) {
      Dictionary<string, string> pair = copies[keys[i]];
      Dictionary<string, object> item = new Dictionary<string, object>();
      item["source"] = pair["source"];
      item["target"] = pair["target"];
      list.Add(item);
    }
    current["copies"] = list;
  }

  static bool TryCopyKey(string key, out int index, out bool isSource) {
    index = 0;
    isSource = false;
    if (key.Length < 12 || !key.StartsWith("Copy", StringComparison.OrdinalIgnoreCase)) return false;
    int pos = 4;
    if (pos >= key.Length || !char.IsDigit(key[pos])) return false;
    int value = 0;
    while (pos < key.Length && char.IsDigit(key[pos])) {
      value = value * 10 + (key[pos] - '0');
      pos++;
    }
    if (value < 1 || pos >= key.Length || key[pos] != '.') return false;
    string field = key.Substring(pos + 1);
    if (field.Equals("Source", StringComparison.OrdinalIgnoreCase)) {
      index = value;
      isSource = true;
      return true;
    }
    if (field.Equals("Target", StringComparison.OrdinalIgnoreCase)) {
      index = value;
      isSource = false;
      return true;
    }
    return false;
  }

  static string RenderIni(List<Dictionary<string, object>> projects) {
    StringBuilder text = new StringBuilder();
    text.Append("; Each section is one publish project.\r\n");
    text.Append("; Pair files with CopyN.Source / CopyN.Target. N starts at 1 and does not need to be consecutive.\r\n");
    for (int i = 0; i < projects.Count; i++) {
      Dictionary<string, object> project = projects[i];
      text.Append("\r\n[");
      text.Append(ValueOf(project, "section").Trim());
      text.Append("]\r\n");
      text.Append("Name = ");
      text.Append(ValueOf(project, "name").Trim());
      text.Append("\r\n");
      string mims = ValueOf(project, "mimsConfigPath").Trim();
      if (mims.Length > 0) {
        text.Append("MimsConfigPath = ");
        text.Append(mims);
        text.Append("\r\n");
      }
      ArrayList copies = project["copies"] as ArrayList;
      int number = 1;
      if (copies != null) {
        foreach (object copyObj in copies) {
          Dictionary<string, object> copy = copyObj as Dictionary<string, object>;
          if (copy == null) continue;
          string source = ValueOf(copy, "source").Trim();
          string target = ValueOf(copy, "target").Trim();
          if (source.Length == 0 && target.Length == 0) continue;
          text.Append("Copy");
          text.Append(number);
          text.Append(".Source = ");
          text.Append(source);
          text.Append("\r\nCopy");
          text.Append(number);
          text.Append(".Target = ");
          text.Append(target);
          text.Append("\r\n");
          number++;
        }
      }
    }
    return text.ToString();
  }

  static string SaveCatalog(HttpListenerRequest request) {
    if (request.ContentLength64 > 20L * 1024L * 1024L) return "数据库过大";
    byte[] bytes;
    using (MemoryStream memory = new MemoryStream()) {
      byte[] buffer = new byte[8192];
      int read;
      while ((read = request.InputStream.Read(buffer, 0, buffer.Length)) > 0) {
        memory.Write(buffer, 0, read);
        if (memory.Length > 20L * 1024L * 1024L) return "数据库过大";
      }
      bytes = memory.ToArray();
    }
    if (bytes.Length < 16 || Encoding.ASCII.GetString(bytes, 0, 15) != "SQLite format 3") return "不是 SQLite 数据库";
    string local = Path.Combine(Root, "catalog.db");
    string tmp = local + ".tmp";
    try {
      File.WriteAllBytes(tmp, bytes);
      if (File.Exists(local)) File.Replace(tmp, local, null);
      else File.Move(tmp, local);
      return null;
    } catch (Exception ex) {
      try {
        if (File.Exists(tmp)) File.Delete(tmp);
      } catch (Exception) { }
      return ex.Message;
    }
  }

  static void SyncIndex(HttpListenerResponse response) {
    string local = Path.Combine(Root, "otdr_index.db");
    bool localExists = File.Exists(local);
    bool nasExists = false;
    try {
      nasExists = File.Exists(NasDb);
    } catch (Exception) {
      nasExists = false;
    }
    if (!nasExists) {
      Send(response, 200, "application/json",
        "{\"updated\":false,\"status\":\"unavailable\",\"local\":" + (localExists ? "true" : "false") + "}");
      return;
    }

    DateTime nasTime = File.GetLastWriteTime(NasDb);
    string nasText = nasTime.ToString("yyyy-MM-dd HH:mm:ss");
    if (localExists) {
      DateTime localTime = File.GetLastWriteTime(local);
      if (SameSecond(nasTime, localTime)) {
        Send(response, 200, "application/json",
          "{\"updated\":false,\"status\":\"same\",\"local\":true,\"nasTime\":\"" + nasText +
          "\",\"localTime\":\"" + localTime.ToString("yyyy-MM-dd HH:mm:ss") + "\"}");
        return;
      }
    }

    string tmp = local + ".tmp";
    try {
      File.Copy(NasDb, tmp, true);
      if (File.Exists(local)) File.Replace(tmp, local, null);
      else File.Move(tmp, local);
      CopySidecar(NasDb, local, "-wal");
      CopySidecar(NasDb, local, "-shm");
      Checkpoint(local);
      File.SetLastWriteTime(local, nasTime);
      Send(response, 200, "application/json",
        "{\"updated\":true,\"status\":\"copied\",\"local\":true,\"nasTime\":\"" + nasText +
        "\",\"localTime\":\"" + nasText + "\"}");
    } catch (Exception ex) {
      try {
        if (File.Exists(tmp)) File.Delete(tmp);
      } catch (Exception) { }
      Send(response, 500, "application/json",
        "{\"updated\":false,\"status\":\"error\",\"local\":" + (File.Exists(local) ? "true" : "false") +
        ",\"message\":\"" + JsonEscape(ex.Message) + "\"}");
    }
  }

  static bool SameSecond(DateTime left, DateTime right) {
    return left.ToUniversalTime().Ticks / TimeSpan.TicksPerSecond ==
      right.ToUniversalTime().Ticks / TimeSpan.TicksPerSecond;
  }

  static void CopySidecar(string nasDb, string localDb, string suffix) {
    string src = nasDb + suffix;
    string dst = localDb + suffix;
    bool srcExists = false;
    try {
      srcExists = File.Exists(src);
    } catch (Exception) {
      srcExists = false;
    }
    if (!srcExists) {
      try {
        if (File.Exists(dst)) File.Delete(dst);
      } catch (Exception) { }
      return;
    }
    string tmp = dst + ".tmp";
    File.Copy(src, tmp, true);
    DateTime stamp = File.GetLastWriteTime(src);
    if (File.Exists(dst)) File.Replace(tmp, dst, null);
    else File.Move(tmp, dst);
    File.SetLastWriteTime(dst, stamp);
  }

  static void Checkpoint(string local) {
    if (!File.Exists(local + "-wal")) return;
    try {
      ProcessStartInfo start = new ProcessStartInfo();
      start.FileName = "python";
      start.Arguments = "-c \"import sqlite3; c=sqlite3.connect(r'" + local +
        "'); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()\"";
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      Process process = Process.Start(start);
      if (process != null) process.WaitForExit(20000);
    } catch (Exception) { }
  }

  static string JsonEscape(string value) {
    if (value == null) return "";
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
  }

  static bool OpenFolder(string path) {
    bool drive = path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\';
    bool unc = path.StartsWith("\\\\") && path.IndexOf('\\', 2) > 2;
    if ((!drive && !unc) || path.IndexOfAny(new char[] { '\r', '\n', '"' }) >= 0) return false;
    ProcessStartInfo start = new ProcessStartInfo();
    start.FileName = Environment.GetEnvironmentVariable("SystemRoot") + "\\explorer.exe";
    start.Arguments = "\"" + path + "\"";
    start.UseShellExecute = true;
    Process.Start(start);
    return true;
  }

  static string ContentType(string path) {
    string ext = Path.GetExtension(path).ToLowerInvariant();
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".js") return "text/javascript; charset=utf-8";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".webp") return "image/webp";
    if (ext == ".wasm") return "application/wasm";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".woff2") return "font/woff2";
    if (ext == ".woff") return "font/woff";
    if (ext == ".ttf") return "font/ttf";
    return "application/octet-stream";
  }

  // 静态文件按磁盘流式写出，并用 ETag 回 304。页面来回切换时不再把整份脚本读进内存再重传。
  static void SendStatic(HttpListenerRequest request, HttpListenerResponse response, string full) {
    FileInfo info = new FileInfo(full);
    string etag = "\"" + info.LastWriteTimeUtc.Ticks.ToString() + "-" + info.Length.ToString() + "\"";
    response.Headers["ETag"] = etag;
    response.Headers["Cache-Control"] = "no-cache";
    response.Headers["Access-Control-Allow-Origin"] = "*";
    response.Headers["Access-Control-Allow-Private-Network"] = "true";
    string match = request.Headers["If-None-Match"];
    if (match != null && string.Equals(match, etag, StringComparison.Ordinal)) {
      response.StatusCode = 304;
      response.ContentLength64 = 0;
      response.OutputStream.Close();
      return;
    }
    response.StatusCode = 200;
    response.ContentType = ContentType(full);
    response.ContentLength64 = info.Length;
    if (!string.Equals(request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase)) {
      byte[] buffer = new byte[65536];
      using (FileStream stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) {
          response.OutputStream.Write(buffer, 0, read);
        }
      }
    }
    response.OutputStream.Close();
  }

  static void Send(HttpListenerResponse response, int status, string type, string body) {
    byte[] bytes = Encoding.UTF8.GetBytes(body ?? "");
    response.StatusCode = status;
    response.ContentType = type + "; charset=utf-8";
    response.ContentLength64 = bytes.Length;
    response.OutputStream.Write(bytes, 0, bytes.Length);
    response.OutputStream.Close();
  }

  // ===== 截图：Alt+A，交互照着 Snipaste（冻结画面、框选或点窗口、贴在原处） =====

  const int WmHotkey = 0x0312;
  const int WmClipboardUpdate = 0x031D;
  const int HotkeyId = 0x4732;
  const int WhKeyboardLl = 13;
  const int WmKeydown = 0x0100;
  const int WmSyskeydown = 0x0104;
  const int VkMenu = 0x12;
  const uint ModAlt = 0x0001;
  const uint ModNorepeat = 0x4000;
  const uint VkA = 0x41;
  const uint VkQ = 0x51;
  const uint VkE = 0x45;
  static readonly IntPtr HwndTopmost = new IntPtr(-1);
  static bool snipOpen;
  static HotkeyForm hotkeyFormInstance;
  static LowLevelKeyboardProc clipKeyboardProc;
  static IntPtr clipKeyboardHook;
  static int clipHotkeyVk;
  static long clipHotkeyTick;

  static void StartScreenshotHotkey() {
    Thread thread = new Thread(ScreenshotLoop);
    thread.Name = "screenshot";
    thread.IsBackground = true;
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
  }

  static void ScreenshotLoop() {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    WarmUpSnip();
    Application.Run(new HotkeyForm());
  }

  // 第一次按 Alt+A 要现加载 GDI+ 和字体，会慢一秒多；启动时先走一遍，按键时就是即开
  static void WarmUpSnip() {
    try {
      using (Bitmap bitmap = new Bitmap(8, 8, PixelFormat.Format32bppPArgb))
      using (Graphics g = Graphics.FromImage(bitmap))
      using (Font ui = new Font("Microsoft YaHei UI", 9f, GraphicsUnit.Point))
      using (Font mono = new Font("Consolas", 9f, GraphicsUnit.Point))
      using (GraphicsPath path = RoundedRect(new Rectangle(0, 0, 8, 8), 2)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.FillPath(Brushes.Black, path);
        TextRenderer.MeasureText("1920 × 1080 截图", ui);
        TextRenderer.DrawText(g, "0, 0 #FFFFFF", mono, new Point(0, 0), Color.White);
      }
      Font icons = IconFont(10f);
      if (icons != null) icons.Dispose();
      ScreenScale();
    } catch (Exception) { }
  }

  static void CopyImage(Image image) {
    for (int i = 0; i < 4; i++) {
      try {
        Clipboard.SetImage(image);
        return;
      } catch (Exception) {
        Thread.Sleep(40);
      }
    }
  }

  static void StartSnip() {
    if (snipOpen) return;
    Rectangle bounds = SystemInformation.VirtualScreen;
    if (bounds.Width < 2 || bounds.Height < 2) return;
    Bitmap shot = null;
    try {
      shot = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(shot)) {
        g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
      }
    } catch (Exception) {
      if (shot != null) shot.Dispose();
      return;
    }
    snipOpen = true;
    CaptureOverlay overlay = new CaptureOverlay(shot, bounds);
    overlay.FormClosed += delegate { snipOpen = false; };
    overlay.Show();
    overlay.Activate();
  }

  // 不显示的消息窗口，只为了接收全局热键。必须跟截图窗在同一个 STA 线程上。
  static void InstallClipKeyboardHook() {
    if (clipKeyboardHook != IntPtr.Zero) return;
    clipKeyboardProc = ClipKeyboardHookProc;
    ProcessModule module = Process.GetCurrentProcess().MainModule;
    clipKeyboardHook = SetWindowsHookEx(WhKeyboardLl, clipKeyboardProc, GetModuleHandle(module.ModuleName), 0);
  }

  static void RemoveClipKeyboardHook() {
    if (clipKeyboardHook == IntPtr.Zero) return;
    try { UnhookWindowsHookEx(clipKeyboardHook); } catch (Exception) { }
    clipKeyboardHook = IntPtr.Zero;
    clipKeyboardProc = null;
  }

  // Alt+Q / Alt+E 常被 IDE 占用 RegisterHotKey，改用全局低级键盘钩子。
  static IntPtr ClipKeyboardHookProc(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode < 0) return CallNextHookEx(clipKeyboardHook, nCode, wParam, lParam);
    int msg = wParam.ToInt32();
    if (msg != WmKeydown && msg != WmSyskeydown) return CallNextHookEx(clipKeyboardHook, nCode, wParam, lParam);
    int vk = Marshal.ReadInt32(lParam);
    if (vk == VkC || vk == VkX) {
      if ((GetAsyncKeyState(VkControl) & 0x8000) != 0) {
        clipCopyKeyAt = DateTime.UtcNow.Ticks / 10000;
      }
      return CallNextHookEx(clipKeyboardHook, nCode, wParam, lParam);
    }
    if (vk != VkQ && vk != VkE) return CallNextHookEx(clipKeyboardHook, nCode, wParam, lParam);
    if ((GetAsyncKeyState(VkMenu) & 0x8000) == 0) return CallNextHookEx(clipKeyboardHook, nCode, wParam, lParam);
    long now = DateTime.UtcNow.Ticks / 10000;
    if (clipHotkeyVk == vk && now - clipHotkeyTick < 280) return (IntPtr)1;
    clipHotkeyVk = vk;
    clipHotkeyTick = now;
    HotkeyForm form = hotkeyFormInstance;
    if (form != null && !form.IsDisposed) {
      int dir = vk == VkQ ? -1 : 1;
      try {
        form.BeginInvoke(new MethodInvoker(delegate { ClipStep(dir); }));
      } catch (Exception) { }
    }
    return (IntPtr)1;
  }

  sealed class HotkeyForm : Form {
    public HotkeyForm() {
      hotkeyFormInstance = this;
      ShowInTaskbar = false;
      FormBorderStyle = FormBorderStyle.None;
    }

    // 只借这个窗口收热键，不要让它出现在屏幕上
    protected override void SetVisibleCore(bool value) {
      if (!IsHandleCreated) CreateHandle();
      base.SetVisibleCore(false);
    }

    protected override void OnHandleCreated(EventArgs e) {
      base.OnHandleCreated(e);
      RegisterHotKey(Handle, HotkeyId, ModAlt | ModNorepeat, VkA);
      AddClipboardFormatListener(Handle);
      InstallClipKeyboardHook();
      LoadClipHistory();
    }

    protected override void OnFormClosed(FormClosedEventArgs e) {
      RemoveClipKeyboardHook();
      try { RemoveClipboardFormatListener(Handle); } catch (Exception) { }
      try { UnregisterHotKey(Handle, HotkeyId); } catch (Exception) { }
      if (ReferenceEquals(hotkeyFormInstance, this)) hotkeyFormInstance = null;
      base.OnFormClosed(e);
    }

    protected override void WndProc(ref Message m) {
      if (m.Msg == WmClipboardUpdate) {
        try { CaptureClipboard(false); } catch (Exception) { }
      } else if (m.Msg == WmHotkey && m.WParam.ToInt32() == HotkeyId) {
        try { StartSnip(); } catch (Exception) { }
      }
      base.WndProc(ref m);
    }
  }

  static readonly Color SnipAccent = Color.FromArgb(56, 189, 248);
  static readonly Color SnipPanel = Color.FromArgb(236, 20, 24, 30);
  static readonly Color ClipPanel = Color.FromArgb(255, 20, 24, 30);
  static readonly Color SnipInk = Color.FromArgb(232, 237, 242);
  static readonly Color SnipMuted = Color.FromArgb(150, 162, 176);

  // ===== 剪贴板历史：Alt+Q 上一条，Alt+E 下一条，JSON 存在工作台根目录 =====

  const int ClipMaxItems = 80;
  const int ClipMaxChars = 16 * 1024;
  static readonly string ClipHistoryPath = Path.Combine(Root, "clipboard-history.json");
  static readonly List<ClipItem> clipItems = new List<ClipItem>();
  static int clipIndex;
  static bool clipArmed;
  static long clipCopyKeyAt;
  static string clipLastWritten = "";
  static bool clipSaving;
  static ClipToast clipToast;
  const int VkControl = 0x11;
  const int VkC = 0x43;
  const int VkX = 0x58;

  sealed class ClipItem {
    public string Text;
    public string At;
  }

  static void LoadClipHistory() {
    clipItems.Clear();
    clipIndex = 0;
    clipArmed = false;
    try {
      if (!File.Exists(ClipHistoryPath)) return;
      JavaScriptSerializer serializer = new JavaScriptSerializer();
      serializer.MaxJsonLength = 16 * 1024 * 1024;
      Dictionary<string, object> root =
        serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(ClipHistoryPath, Encoding.UTF8));
      if (root == null) return;
      ArrayList raw = root.ContainsKey("items") ? root["items"] as ArrayList : null;
      if (raw == null) return;
      for (int i = 0; i < raw.Count && clipItems.Count < ClipMaxItems; i++) {
        Dictionary<string, object> row = raw[i] as Dictionary<string, object>;
        if (row == null) continue;
        string text = ValueOf(row, "text");
        if (text.Length == 0) continue;
        if (text.Length > ClipMaxChars) text = text.Substring(0, ClipMaxChars);
        ClipItem item = new ClipItem();
        item.Text = text;
        item.At = ValueOf(row, "at");
        clipItems.Add(item);
      }
    } catch (Exception) { }
  }

  static void ResetClipHistoryIfFileMissing() {
    if (clipSaving) return;
    if (!File.Exists(ClipHistoryPath) && clipItems.Count > 0) {
      clipItems.Clear();
      clipIndex = 0;
      clipArmed = false;
    }
  }

  static bool IsHistoryPayload(string text) {
    if (text == null || text.Length < 24) return false;
    string head = text.TrimStart();
    return head.StartsWith("{\"version\":", StringComparison.Ordinal)
      && head.IndexOf("\"items\":", StringComparison.Ordinal) >= 0;
  }

  static void SaveClipHistory() {
    clipSaving = true;
    try {
      List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
      for (int i = 0; i < clipItems.Count; i++) {
        Dictionary<string, object> row = new Dictionary<string, object>();
        row["text"] = clipItems[i].Text;
        row["at"] = clipItems[i].At;
        rows.Add(row);
      }
      Dictionary<string, object> root = new Dictionary<string, object>();
      root["version"] = 1;
      root["updatedAt"] = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
      root["items"] = rows;
      JavaScriptSerializer serializer = new JavaScriptSerializer();
      serializer.MaxJsonLength = 16 * 1024 * 1024;
      string json = serializer.Serialize(root);
      string tmp = ClipHistoryPath + ".tmp";
      File.WriteAllText(tmp, json, new UTF8Encoding(false));
      if (File.Exists(ClipHistoryPath)) File.Replace(tmp, ClipHistoryPath, null);
      else File.Move(tmp, ClipHistoryPath);
    } catch (Exception) { }
    finally {
      clipSaving = false;
    }
  }

  static string ReadClipboardText() {
    for (int i = 0; i < 4; i++) {
      try {
        if (Clipboard.ContainsText(TextDataFormat.UnicodeText)) return Clipboard.GetText(TextDataFormat.UnicodeText);
        if (Clipboard.ContainsText(TextDataFormat.Text)) return Clipboard.GetText(TextDataFormat.Text);
        return "";
      } catch (Exception) {
        Thread.Sleep(40);
      }
    }
    return "";
  }

  static void WriteClipboardText(string text) {
    clipLastWritten = text == null ? "" : text;
    for (int i = 0; i < 4; i++) {
      try {
        Clipboard.SetText(text, TextDataFormat.UnicodeText);
        return;
      } catch (Exception) {
        Thread.Sleep(40);
      }
    }
  }

  static void CaptureClipboard(bool force) {
    ResetClipHistoryIfFileMissing();
    if (clipSaving) return;
    string text = ReadClipboardText();
    if (text == null) text = "";
    if (text.Length == 0) return;
    if (!force) {
      if (clipLastWritten.Length > 0 && string.Equals(text, clipLastWritten, StringComparison.Ordinal)) {
        clipLastWritten = "";
        return;
      }
      if (IsHistoryPayload(text)) return;
      long now = DateTime.UtcNow.Ticks / 10000;
      if (clipCopyKeyAt <= 0 || now - clipCopyKeyAt > 5000) return;
      clipCopyKeyAt = 0;
    }
    if (text.Length > ClipMaxChars) text = text.Substring(0, ClipMaxChars);
    if (clipItems.Count > 0 && string.Equals(clipItems[0].Text, text, StringComparison.Ordinal)) {
      if (force) {
        clipIndex = 0;
        clipArmed = false;
      }
      return;
    }
    ClipItem item = new ClipItem();
    item.Text = text;
    item.At = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
    clipItems.Insert(0, item);
    while (clipItems.Count > ClipMaxItems) clipItems.RemoveAt(clipItems.Count - 1);
    clipIndex = 0;
    clipArmed = false;
    SaveClipHistory();
  }

  // dir < 0：上一条（更早）；dir > 0：下一条（更新）。第一次按键先落到当前这条。
  static void ClipStep(int dir) {
    CaptureClipboard(false);
    if (clipItems.Count == 0) {
      ShowClipToast("剪贴板", "还没有文字记录。复制一段文字后再按 Alt+Q。");
      return;
    }
    if (!clipArmed) {
      clipArmed = true;
      clipIndex = 0;
    } else if (dir < 0 && clipIndex < clipItems.Count - 1) {
      clipIndex++;
    } else if (dir > 0 && clipIndex > 0) {
      clipIndex--;
    }
    WriteClipboardText(clipItems[clipIndex].Text);
    string title = "剪贴板 " + (clipIndex + 1).ToString() + "/" + clipItems.Count.ToString();
    if (clipIndex == 0) title += " · 当前";
    else if (clipIndex == clipItems.Count - 1) title += " · 最早";
    ShowClipToast(title, PreviewClip(clipItems[clipIndex].Text));
  }

  static string PreviewClip(string text) {
    if (text == null) return "";
    string value = text.Replace("\r\n", "\n").Replace('\r', '\n');
    string[] lines = value.Split('\n');
    StringBuilder preview = new StringBuilder();
    int take = Math.Min(lines.Length, 10);
    int used = 0;
    for (int i = 0; i < take; i++) {
      string line = lines[i];
      if (used + line.Length > 400) {
        if (preview.Length > 0) preview.Append('\n');
        preview.Append(line.Substring(0, Math.Max(0, 400 - used)));
        preview.Append("…");
        return preview.ToString();
      }
      if (preview.Length > 0) preview.Append('\n');
      preview.Append(line);
      used += line.Length + 1;
    }
    if (lines.Length > take || value.Length > 400) preview.Append("…");
    return preview.ToString();
  }

  static void ShowClipToast(string title, string body) {
    if (clipToast == null || clipToast.IsDisposed) clipToast = new ClipToast();
    clipToast.ShowText(title, body);
  }

  sealed class ClipToast : Form {
    string title = "";
    string body = "";
    readonly Font titleFont;
    readonly Font bodyFont;
    readonly System.Windows.Forms.Timer hideTimer = new System.Windows.Forms.Timer();

    public ClipToast() {
      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      BackColor = ClipPanel;
      AutoScaleMode = AutoScaleMode.None;
      SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
      titleFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold, GraphicsUnit.Point);
      bodyFont = new Font("Microsoft YaHei UI", 9.5f, GraphicsUnit.Point);
      hideTimer.Interval = 3200;
      hideTimer.Tick += delegate {
        hideTimer.Stop();
        Hide();
      };
    }

    protected override bool ShowWithoutActivation {
      get { return true; }
    }

    public void ShowText(string nextTitle, string nextBody) {
      title = nextTitle == null ? "" : nextTitle;
      body = nextBody == null ? "" : nextBody;
      LayoutToast();
      if (!IsHandleCreated) CreateHandle();
      if (!Visible) Show();
      else {
        Invalidate();
        Update();
      }
      SetWindowPos(Handle, HwndTopmost, Left, Top, Width, Height, 0x0050);
      hideTimer.Stop();
      hideTimer.Start();
    }

    void LayoutToast() {
      float scale = ScreenScale();
      int pad = Math.Max(12, (int)Math.Round(14 * scale));
      int gap = Math.Max(6, (int)Math.Round(8 * scale));
      Rectangle work = Screen.FromPoint(Control.MousePosition).WorkingArea;
      int maxW = Math.Min(Math.Max(280, (int)Math.Round(520 * scale)), work.Width - 48);
      Size titleSize = TextRenderer.MeasureText(title, titleFont, new Size(maxW - pad * 2, 0), TextFormatFlags.NoPadding);
      Size bodySize = TextRenderer.MeasureText(
        body.Length == 0 ? " " : body,
        bodyFont,
        new Size(maxW - pad * 2, 0),
        TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding
      );
      int width = Math.Min(maxW, Math.Max(titleSize.Width, bodySize.Width) + pad * 2);
      int height = pad + titleSize.Height + gap + bodySize.Height + pad;
      int x = work.X + (work.Width - width) / 2;
      int y = work.Bottom - height - Math.Max(48, (int)Math.Round(72 * scale));
      Bounds = new Rectangle(x, y, width, height);
    }

    protected override void OnPaint(PaintEventArgs e) {
      Graphics g = e.Graphics;
      g.SmoothingMode = SmoothingMode.AntiAlias;
      Rectangle box = new Rectangle(0, 0, Width - 1, Height - 1);
      using (GraphicsPath path = RoundedRect(box, 10))
      using (SolidBrush fill = new SolidBrush(ClipPanel))
      using (Pen edge = new Pen(Color.FromArgb(72, 84, 98))) {
        g.FillPath(fill, path);
        g.DrawPath(edge, path);
      }
      float scale = ScreenScale();
      int pad = Math.Max(12, (int)Math.Round(14 * scale));
      int gap = Math.Max(6, (int)Math.Round(8 * scale));
      Rectangle titleBox = new Rectangle(pad, pad, Width - pad * 2, 24);
      TextRenderer.DrawText(g, title, titleFont, titleBox, SnipAccent, TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
      Size titleSize = TextRenderer.MeasureText(title, titleFont, new Size(Width - pad * 2, 0), TextFormatFlags.NoPadding);
      Rectangle bodyBox = new Rectangle(pad, pad + titleSize.Height + gap, Width - pad * 2, Height - pad * 2 - titleSize.Height - gap);
      TextRenderer.DrawText(
        g,
        body,
        bodyFont,
        bodyBox,
        SnipInk,
        TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding
      );
    }

    protected override void OnMouseDown(MouseEventArgs e) {
      hideTimer.Stop();
      Hide();
    }

    protected override void OnFormClosed(FormClosedEventArgs e) {
      hideTimer.Stop();
      hideTimer.Dispose();
      titleFont.Dispose();
      bodyFont.Dispose();
      base.OnFormClosed(e);
    }
  }

  static GraphicsPath RoundedRect(Rectangle r, int radius) {
    GraphicsPath path = new GraphicsPath();
    int d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
    if (d < 2) {
      path.AddRectangle(r);
      return path;
    }
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }

  static void FillPanel(Graphics g, Rectangle r, int radius) {
    SmoothingMode old = g.SmoothingMode;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    using (GraphicsPath path = RoundedRect(r, radius))
    using (SolidBrush fill = new SolidBrush(SnipPanel))
    using (Pen edge = new Pen(Color.FromArgb(46, 255, 255, 255), 1)) {
      g.FillPath(fill, path);
      g.DrawPath(edge, path);
    }
    g.SmoothingMode = old;
  }

  static float ScreenScale() {
    try {
      using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return Math.Max(1f, g.DpiX / 96f);
    } catch (Exception) {
      return 1f;
    }
  }

  // 没装图标字体的系统就只显示文字，不画成一排方块
  static Font IconFont(float size) {
    Font font = new Font("Segoe MDL2 Assets", size, GraphicsUnit.Point);
    if (string.Equals(font.Name, "Segoe MDL2 Assets", StringComparison.OrdinalIgnoreCase)) return font;
    font.Dispose();
    return null;
  }

  static Rectangle UnionRect(Rectangle a, Rectangle b) {
    if (a.Width <= 0 || a.Height <= 0) return b;
    if (b.Width <= 0 || b.Height <= 0) return a;
    return Rectangle.Union(a, b);
  }

  const TextFormatFlags SnipText = TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter;

  sealed class CaptureOverlay : Form {
    const int MagCols = 17;
    const int MagRows = 13;
    const string Hint = "拖动框选区域 · 单击截取窗口 · 方向键微调 · Esc 退出";
    Bitmap screen;
    Bitmap dimmed;
    readonly Rectangle bounds;
    readonly float scale;
    readonly Font uiFont;
    readonly Font monoFont;
    bool dragging;
    Point anchor;
    Point current;
    Point pointer;
    bool hasPointer;
    Rectangle hover;
    string hoverTitle = "";
    Rectangle lastDirty;

    public CaptureOverlay(Bitmap shot, Rectangle virtualBounds) {
      screen = shot;
      bounds = virtualBounds;
      scale = ScreenScale();
      uiFont = new Font("Microsoft YaHei UI", 9f, GraphicsUnit.Point);
      monoFont = new Font("Consolas", 9f, GraphicsUnit.Point);
      // 暗化底图只做一次；之后每帧只把选区那一块亮图贴上去，拖动时不必整屏重绘
      dimmed = new Bitmap(shot.Width, shot.Height, PixelFormat.Format32bppPArgb);
      using (Graphics g = Graphics.FromImage(dimmed)) {
        g.DrawImageUnscaled(shot, 0, 0);
        using (SolidBrush shade = new SolidBrush(Color.FromArgb(128, 10, 14, 20))) {
          g.FillRectangle(shade, 0, 0, shot.Width, shot.Height);
        }
      }
      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      KeyPreview = true;
      Cursor = Cursors.Cross;
      BackColor = Color.Black;
      AutoScaleMode = AutoScaleMode.None;
      SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
      Bounds = virtualBounds;
      lastDirty = new Rectangle(0, 0, virtualBounds.Width, virtualBounds.Height);
    }

    int S(int value) { return (int)Math.Round(value * scale); }

    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= 0x00000080;
        return cp;
      }
    }

    protected override void OnShown(EventArgs e) {
      base.OnShown(e);
      SetWindowPos(Handle, HwndTopmost, bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0010);
      Activate();
      pointer = PointToClient(Cursor.Position);
      hasPointer = true;
      hover = WindowRectAt(pointer, out hoverTitle);
      Invalidate();
    }

    protected override void OnFormClosed(FormClosedEventArgs e) {
      if (screen != null) {
        screen.Dispose();
        screen = null;
      }
      if (dimmed != null) {
        dimmed.Dispose();
        dimmed = null;
      }
      uiFont.Dispose();
      monoFont.Dispose();
      base.OnFormClosed(e);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
      Keys key = keyData & Keys.KeyCode;
      if (key == Keys.Escape) {
        Close();
        return true;
      }
      if (key == Keys.Left || key == Keys.Right || key == Keys.Up || key == Keys.Down) {
        int step = (keyData & Keys.Shift) == Keys.Shift ? 10 : 1;
        Point p = Cursor.Position;
        if (key == Keys.Left) p.X -= step;
        if (key == Keys.Right) p.X += step;
        if (key == Keys.Up) p.Y -= step;
        if (key == Keys.Down) p.Y += step;
        Cursor.Position = p;
        return true;
      }
      if (key == Keys.Enter && !dragging) {
        Finish(hover.Width >= 4 && hover.Height >= 4 ? hover : ClientRectangle);
        return true;
      }
      return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnMouseDown(MouseEventArgs e) {
      if (e.Button == MouseButtons.Right) {
        if (dragging) {
          dragging = false;
          UpdateDirty();
          return;
        }
        Close();
        return;
      }
      if (e.Button != MouseButtons.Left) return;
      dragging = true;
      anchor = e.Location;
      current = e.Location;
      UpdateDirty();
    }

    protected override void OnMouseMove(MouseEventArgs e) {
      pointer = e.Location;
      hasPointer = true;
      if (dragging) current = e.Location;
      else hover = WindowRectAt(e.Location, out hoverTitle);
      UpdateDirty();
    }

    protected override void OnMouseUp(MouseEventArgs e) {
      if (!dragging || e.Button != MouseButtons.Left) return;
      dragging = false;
      current = e.Location;
      Rectangle sel = Selection();
      if (sel.Width < 4 || sel.Height < 4) {
        if (hover.Width >= 4 && hover.Height >= 4) sel = hover;
        else {
          Close();
          return;
        }
      }
      Finish(sel);
    }

    Rectangle LiveRect() {
      return dragging ? Selection() : hover;
    }

    // 只重画装饰物前后两帧占过的地方
    void UpdateDirty() {
      Rectangle next = DecorBounds();
      if (lastDirty.Width > 0 && lastDirty.Height > 0) Invalidate(lastDirty);
      if (next.Width > 0 && next.Height > 0) Invalidate(next);
      lastDirty = next;
    }

    Rectangle DecorBounds() {
      Rectangle area = Rectangle.Empty;
      Rectangle live = LiveRect();
      if (live.Width > 0 && live.Height > 0) {
        Rectangle grown = live;
        grown.Inflate(S(8), S(8));
        area = UnionRect(grown, BadgeRect(live));
      }
      if (!dragging) area = UnionRect(area, HintRect());
      if (hasPointer) area = UnionRect(area, MagnifierRect());
      area.Inflate(2, 2);
      return area;
    }

    string BadgeText(Rectangle live) {
      string size = live.Width.ToString() + " × " + live.Height.ToString();
      if (dragging || hoverTitle.Length == 0) return size;
      string title = hoverTitle.Length > 40 ? hoverTitle.Substring(0, 40) + "…" : hoverTitle;
      return size + "   " + title;
    }

    Rectangle BadgeRect(Rectangle live) {
      Size text = TextRenderer.MeasureText(BadgeText(live), uiFont, Size.Empty, TextFormatFlags.NoPadding);
      int w = text.Width + S(18);
      int h = text.Height + S(10);
      int x = live.X;
      int y = live.Y - h - S(6);
      if (y < S(4)) y = live.Y + S(6);
      if (y < S(4)) y = S(4);
      if (x + w > ClientSize.Width - S(4)) x = ClientSize.Width - S(4) - w;
      if (x < S(4)) x = S(4);
      return new Rectangle(x, y, w, h);
    }

    Rectangle HintRect() {
      Rectangle monitor = MonitorRect();
      Size text = TextRenderer.MeasureText(Hint, uiFont, Size.Empty, TextFormatFlags.NoPadding);
      int w = text.Width + S(32);
      int h = text.Height + S(16);
      int x = monitor.X + (monitor.Width - w) / 2;
      int y = monitor.Y + S(24);
      return new Rectangle(x, y, w, h);
    }

    // 以光标所在显示器为界翻转，多屏上下/左右拼接时放大镜不会跑到屏幕缝外面
    Rectangle MonitorRect() {
      Rectangle monitor = Screen.FromPoint(new Point(bounds.X + pointer.X, bounds.Y + pointer.Y)).Bounds;
      return new Rectangle(monitor.X - bounds.X, monitor.Y - bounds.Y, monitor.Width, monitor.Height);
    }

    Rectangle MagnifierRect() {
      int cell = S(7);
      int pad = S(6);
      int w = MagCols * cell + pad * 2;
      int h = MagRows * cell + pad + S(48);
      int gap = S(22);
      int margin = S(4);
      Rectangle area = MonitorRect();
      int x = pointer.X + gap;
      int y = pointer.Y + gap;
      if (x + w > area.Right - margin) x = pointer.X - gap - w;
      if (y + h > area.Bottom - margin) y = pointer.Y - gap - h;
      if (x < area.Left + margin) x = area.Left + margin;
      if (y < area.Top + margin) y = area.Top + margin;
      return new Rectangle(x, y, w, h);
    }

    Rectangle Selection() {
      int x = Math.Min(anchor.X, current.X);
      int y = Math.Min(anchor.Y, current.Y);
      int w = Math.Abs(anchor.X - current.X);
      int h = Math.Abs(anchor.Y - current.Y);
      Rectangle rect = new Rectangle(x, y, w, h);
      rect.Intersect(ClientRectangle);
      return rect;
    }

    Rectangle WindowRectAt(Point client, out string title) {
      title = "";
      Point screenPoint = new Point(bounds.X + client.X, bounds.Y + client.Y);
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
        if (hwnd == Handle || !IsWindowVisible(hwnd)) return true;
        WindowRect wr;
        if (!GetWindowRect(hwnd, out wr)) return true;
        if (screenPoint.X < wr.Left || screenPoint.X >= wr.Right || screenPoint.Y < wr.Top || screenPoint.Y >= wr.Bottom) return true;
        int w = wr.Right - wr.Left;
        int h = wr.Bottom - wr.Top;
        if (w < 32 || h < 32) return true;
        if (w >= bounds.Width - 8 && h >= bounds.Height - 8) return true;
        found = hwnd;
        return false;
      }, IntPtr.Zero);
      if (found == IntPtr.Zero) return Rectangle.Empty;
      WindowRect hit;
      if (!GetWindowRect(found, out hit)) return Rectangle.Empty;
      StringBuilder text = new StringBuilder(256);
      if (GetWindowText(found, text, text.Capacity) > 0) title = text.ToString().Trim();
      Rectangle local = new Rectangle(hit.Left - bounds.X, hit.Top - bounds.Y, hit.Right - hit.Left, hit.Bottom - hit.Top);
      local.Intersect(ClientRectangle);
      return local;
    }

    void Finish(Rectangle clientRect) {
      clientRect.Intersect(new Rectangle(0, 0, screen.Width, screen.Height));
      if (clientRect.Width < 1 || clientRect.Height < 1 || screen == null) {
        Close();
        return;
      }
      Bitmap crop = new Bitmap(clientRect.Width, clientRect.Height, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(crop)) {
        g.DrawImage(screen, new Rectangle(0, 0, crop.Width, crop.Height), clientRect, GraphicsUnit.Pixel);
      }
      Point origin = new Point(bounds.X + clientRect.X, bounds.Y + clientRect.Y);
      CopyImage(crop);
      screen.Dispose();
      screen = null;
      Hide();
      PinForm pin = new PinForm(crop, origin);
      pin.Show();
      pin.Activate();
      Close();
    }

    protected override void OnPaint(PaintEventArgs e) {
      if (screen == null || dimmed == null) return;
      Graphics g = e.Graphics;
      Rectangle clip = e.ClipRectangle;
      g.InterpolationMode = InterpolationMode.NearestNeighbor;
      g.CompositingMode = CompositingMode.SourceCopy;
      g.DrawImage(dimmed, clip, clip, GraphicsUnit.Pixel);
      Rectangle live = LiveRect();
      bool hasLive = live.Width > 0 && live.Height > 0;
      if (hasLive) {
        Rectangle bright = Rectangle.Intersect(live, clip);
        if (bright.Width > 0 && bright.Height > 0) g.DrawImage(screen, bright, bright, GraphicsUnit.Pixel);
      }
      g.CompositingMode = CompositingMode.SourceOver;
      if (hasLive) {
        DrawFrame(g, live);
        DrawBadge(g, live);
      }
      if (!dragging) DrawHint(g);
      if (hasPointer) DrawMagnifier(g);
    }

    void DrawFrame(Graphics g, Rectangle r) {
      int width = Math.Max(1, S(2));
      using (Pen pen = new Pen(SnipAccent, width)) {
        pen.Alignment = PenAlignment.Inset;
        g.DrawRectangle(pen, r.X, r.Y, Math.Max(r.Width - 1, 1), Math.Max(r.Height - 1, 1));
      }
      if (!dragging) return;
      int size = S(7);
      int cx = r.X + r.Width / 2;
      int cy = r.Y + r.Height / 2;
      Point[] handles = new Point[] {
        new Point(r.Left, r.Top), new Point(cx, r.Top), new Point(r.Right - 1, r.Top),
        new Point(r.Left, cy), new Point(r.Right - 1, cy),
        new Point(r.Left, r.Bottom - 1), new Point(cx, r.Bottom - 1), new Point(r.Right - 1, r.Bottom - 1)
      };
      using (SolidBrush fill = new SolidBrush(Color.White))
      using (Pen edge = new Pen(SnipAccent, 1)) {
        foreach (Point p in handles) {
          Rectangle h = new Rectangle(p.X - size / 2, p.Y - size / 2, size, size);
          g.FillRectangle(fill, h);
          g.DrawRectangle(edge, h);
        }
      }
    }

    void DrawBadge(Graphics g, Rectangle live) {
      Rectangle badge = BadgeRect(live);
      FillPanel(g, badge, S(5));
      string text = BadgeText(live);
      string size = live.Width.ToString() + " × " + live.Height.ToString();
      Rectangle inner = new Rectangle(badge.X + S(9), badge.Y, badge.Width - S(18), badge.Height);
      TextRenderer.DrawText(g, size, uiFont, inner, Color.White, SnipText | TextFormatFlags.Left);
      if (text.Length > size.Length) {
        int used = TextRenderer.MeasureText(size, uiFont, Size.Empty, TextFormatFlags.NoPadding).Width;
        Rectangle rest = new Rectangle(inner.X + used, inner.Y, inner.Width - used, inner.Height);
        TextRenderer.DrawText(g, text.Substring(size.Length), uiFont, rest, SnipMuted, SnipText | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
      }
    }

    void DrawHint(Graphics g) {
      Rectangle hint = HintRect();
      FillPanel(g, hint, hint.Height / 2);
      TextRenderer.DrawText(g, Hint, uiFont, hint, SnipInk, SnipText | TextFormatFlags.HorizontalCenter);
    }

    void DrawMagnifier(Graphics g) {
      Rectangle panel = MagnifierRect();
      FillPanel(g, panel, S(8));
      int cell = S(7);
      int pad = S(6);
      Rectangle mag = new Rectangle(panel.X + pad, panel.Y + pad, MagCols * cell, MagRows * cell);
      using (SolidBrush black = new SolidBrush(Color.Black)) g.FillRectangle(black, mag);

      Rectangle src = new Rectangle(pointer.X - MagCols / 2, pointer.Y - MagRows / 2, MagCols, MagRows);
      Rectangle visible = Rectangle.Intersect(src, new Rectangle(0, 0, screen.Width, screen.Height));
      if (visible.Width > 0 && visible.Height > 0) {
        Rectangle dest = new Rectangle(
          mag.X + (visible.X - src.X) * cell, mag.Y + (visible.Y - src.Y) * cell,
          visible.Width * cell, visible.Height * cell);
        PixelOffsetMode oldOffset = g.PixelOffsetMode;
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.DrawImage(screen, dest, visible, GraphicsUnit.Pixel);
        g.PixelOffsetMode = oldOffset;
      }

      Rectangle center = new Rectangle(mag.X + (MagCols / 2) * cell, mag.Y + (MagRows / 2) * cell, cell, cell);
      using (SolidBrush band = new SolidBrush(Color.FromArgb(70, SnipAccent))) {
        g.FillRectangle(band, mag.X, center.Y, center.X - mag.X, cell);
        g.FillRectangle(band, center.Right, center.Y, mag.Right - center.Right, cell);
        g.FillRectangle(band, center.X, mag.Y, cell, center.Y - mag.Y);
        g.FillRectangle(band, center.X, center.Bottom, cell, mag.Bottom - center.Bottom);
      }
      using (Pen white = new Pen(Color.White, 1)) g.DrawRectangle(white, center);
      using (Pen edge = new Pen(Color.FromArgb(60, 255, 255, 255), 1)) g.DrawRectangle(edge, mag);

      int sx = bounds.X + pointer.X;
      int sy = bounds.Y + pointer.Y;
      Color color = Color.Black;
      if (pointer.X >= 0 && pointer.Y >= 0 && pointer.X < screen.Width && pointer.Y < screen.Height) {
        color = screen.GetPixel(pointer.X, pointer.Y);
      }
      string hex = "#" + color.R.ToString("X2") + color.G.ToString("X2") + color.B.ToString("X2");
      int lineH = S(20);
      Rectangle line1 = new Rectangle(mag.X, mag.Bottom + S(4), mag.Width, lineH);
      Rectangle line2 = new Rectangle(mag.X, line1.Bottom, mag.Width, lineH);
      TextRenderer.DrawText(g, "坐标", uiFont, line1, SnipMuted, SnipText | TextFormatFlags.Left);
      TextRenderer.DrawText(g, sx.ToString() + ", " + sy.ToString(), monoFont, line1, SnipInk, SnipText | TextFormatFlags.Right);
      int swatch = S(12);
      Rectangle chip = new Rectangle(line2.X, line2.Y + (lineH - swatch) / 2, swatch, swatch);
      using (SolidBrush fill = new SolidBrush(color)) g.FillRectangle(fill, chip);
      using (Pen edge = new Pen(Color.FromArgb(120, 255, 255, 255), 1)) g.DrawRectangle(edge, chip);
      TextRenderer.DrawText(g, hex, monoFont, line2, SnipInk, SnipText | TextFormatFlags.Right);
    }
  }

  sealed class PinForm : Form {
    const int ToolPen = 1;
    const int ToolRect = 2;
    static readonly Color Ink = Color.FromArgb(255, 239, 68, 68);
    static readonly Color HoleKey = Color.FromArgb(255, 1, 254, 3);

    sealed class PinButton {
      public string Glyph;
      public string Label;
      public bool Danger;
      public int ToolId;
      public EventHandler Click;
      public Rectangle Bounds;
    }

    readonly Bitmap image;
    readonly float scale;
    readonly Font uiFont;
    readonly Font iconFont;
    readonly List<PinButton> buttons = new List<PinButton>();
    readonly int imageWidth;
    readonly int imageHeight;
    readonly int barTop;
    readonly int barHeight;
    readonly bool compact;
    readonly bool hole;
    readonly System.Windows.Forms.Timer flashTimer = new System.Windows.Forms.Timer();
    string flash = "";
    int hoverIndex = -1;
    int pressIndex = -1;
    int tool;
    bool drawing;
    Point drawLast;
    Point shapeA;
    Point shapeB;
    bool moving;
    Point moveCursor;
    Point moveOrigin;

    public PinForm(Bitmap shot, Point origin) {
      image = shot;
      scale = ScreenScale();
      uiFont = new Font("Microsoft YaHei UI", 9f, GraphicsUnit.Point);
      iconFont = IconFont(10f);
      FormBorderStyle = FormBorderStyle.None;
      StartPosition = FormStartPosition.Manual;
      ShowInTaskbar = false;
      TopMost = true;
      KeyPreview = true;
      BackColor = Color.FromArgb(22, 26, 32);
      AutoScaleMode = AutoScaleMode.None;
      SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

      AddButton("\uE76D", "画笔", false, ToolPen, delegate { ToggleTool(ToolPen); });
      AddButton("\uE739", "方框", false, ToolRect, delegate { ToggleTool(ToolRect); });
      AddButton("\uE8C8", "复制", false, delegate { CopyImage(image); Close(); });
      AddButton("\uE74E", "保存", false, SaveImage);
      AddButton("\uE711", "关闭", true, delegate { Close(); });

      barHeight = S(38);
      int buttonHeight = S(28);

      Rectangle work = Screen.GetWorkingArea(origin);
      double fit = 1;
      int maxW = work.Width - 24 - 2;
      int maxH = work.Height - 24 - 2 - barHeight;
      if (image.Width > maxW) fit = Math.Min(fit, maxW / (double)image.Width);
      if (image.Height > maxH) fit = Math.Min(fit, maxH / (double)Math.Max(image.Height, 1));
      if (fit < 0.05) fit = 0.05;
      imageWidth = Math.Max(1, (int)Math.Round(image.Width * fit));
      imageHeight = Math.Max(1, (int)Math.Round(image.Height * fit));
      barTop = imageHeight + 1;

      int toolbarWidth = LayoutButtons(false, buttonHeight);
      if (toolbarWidth > imageWidth + 2 && iconFont != null) {
        compact = true;
        toolbarWidth = LayoutButtons(true, buttonHeight);
      }
      int width = Math.Max(imageWidth + 2, toolbarWidth);
      // 截图比工具栏还窄时，图片右侧空出的那块做成透明镂空，不留一块黑底
      hole = imageWidth + 2 < width;
      if (hole) TransparencyKey = HoleKey;
      int height = barTop + barHeight;
      int x = origin.X - 1;
      int y = origin.Y - 1;
      if (x + width > work.Right) x = work.Right - width;
      if (y + height > work.Bottom) y = work.Bottom - height;
      if (x < work.Left) x = work.Left;
      if (y < work.Top) y = work.Top;
      Bounds = new Rectangle(x, y, width, height);

      int right = width - S(8);
      for (int i = buttons.Count - 1; i >= 0; i--) {
        Rectangle r = buttons[i].Bounds;
        right -= r.Width;
        buttons[i].Bounds = new Rectangle(right, barTop + (barHeight - r.Height) / 2, r.Width, r.Height);
        right -= S(4);
      }

      flashTimer.Interval = 1400;
      flashTimer.Tick += delegate {
        flashTimer.Stop();
        flash = "";
        Invalidate();
      };
    }

    int S(int value) { return (int)Math.Round(value * scale); }

    int LayoutButtons(bool iconOnly, int buttonHeight) {
      int total = S(8);
      foreach (PinButton b in buttons) {
        int w;
        if (iconOnly) {
          w = S(30);
        } else {
          int labelWidth = TextRenderer.MeasureText(b.Label, uiFont, Size.Empty, TextFormatFlags.NoPadding).Width;
          w = S(8) + (iconFont != null ? S(18) : 0) + labelWidth + S(8);
        }
        b.Bounds = new Rectangle(0, 0, w, buttonHeight);
        total += w + S(4);
      }
      return total + S(4);
    }

    void AddButton(string glyph, string label, bool danger, EventHandler click) {
      AddButton(glyph, label, danger, 0, click);
    }

    void AddButton(string glyph, string label, bool danger, int toolId, EventHandler click) {
      PinButton b = new PinButton();
      b.Glyph = glyph;
      b.Label = label;
      b.Danger = danger;
      b.ToolId = toolId;
      b.Click = click;
      buttons.Add(b);
    }

    void ToggleTool(int id) {
      drawing = false;
      tool = tool == id ? 0 : id;
      Invalidate();
    }

    bool OverImage(Point client) {
      return client.X >= 1 && client.Y >= 1 && client.X < 1 + imageWidth && client.Y < 1 + imageHeight;
    }

    Point ToImage(Point client) {
      int x = client.X - 1;
      int y = client.Y - 1;
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if (x > imageWidth - 1) x = imageWidth - 1;
      if (y > imageHeight - 1) y = imageHeight - 1;
      int ix = (int)Math.Round(x * (image.Width - 1) / (double)Math.Max(imageWidth - 1, 1));
      int iy = (int)Math.Round(y * (image.Height - 1) / (double)Math.Max(imageHeight - 1, 1));
      if (ix < 0) ix = 0;
      if (iy < 0) iy = 0;
      if (ix > image.Width - 1) ix = image.Width - 1;
      if (iy > image.Height - 1) iy = image.Height - 1;
      return new Point(ix, iy);
    }

    Rectangle ToClientRect(Rectangle imageRect) {
      double sx = imageWidth / (double)Math.Max(image.Width, 1);
      double sy = imageHeight / (double)Math.Max(image.Height, 1);
      return new Rectangle(
        1 + (int)Math.Round(imageRect.X * sx),
        1 + (int)Math.Round(imageRect.Y * sy),
        Math.Max(1, (int)Math.Round(imageRect.Width * sx)),
        Math.Max(1, (int)Math.Round(imageRect.Height * sy)));
    }

    float StrokeWidth() {
      double sx = image.Width / (double)Math.Max(imageWidth, 1);
      double sy = image.Height / (double)Math.Max(imageHeight, 1);
      return (float)Math.Max(2.0, Math.Round(3.0 * scale * Math.Max(sx, sy)));
    }

    void PaintDot(Point p) {
      float w = StrokeWidth();
      using (Graphics g = Graphics.FromImage(image))
      using (SolidBrush brush = new SolidBrush(Ink)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.FillEllipse(brush, p.X - w / 2f, p.Y - w / 2f, w, w);
      }
    }

    void PaintStroke(Point a, Point b) {
      using (Graphics g = Graphics.FromImage(image))
      using (Pen pen = new Pen(Ink, StrokeWidth())) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        pen.StartCap = LineCap.Round;
        pen.EndCap = LineCap.Round;
        pen.LineJoin = LineJoin.Round;
        g.DrawLine(pen, a, b);
      }
    }

    static Rectangle BoxOf(Point a, Point b) {
      int x = Math.Min(a.X, b.X);
      int y = Math.Min(a.Y, b.Y);
      return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
    }

    void CommitRect(Rectangle r) {
      if (r.Width < 2 && r.Height < 2) return;
      if (r.Width < 1) r.Width = 1;
      if (r.Height < 1) r.Height = 1;
      using (Graphics g = Graphics.FromImage(image))
      using (Pen pen = new Pen(Ink, StrokeWidth())) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        pen.Alignment = PenAlignment.Inset;
        g.DrawRectangle(pen, r);
      }
    }

    void Flash(string text) {
      flash = text;
      flashTimer.Stop();
      flashTimer.Start();
      Invalidate();
    }

    int HitButton(Point p) {
      for (int i = 0; i < buttons.Count; i++) {
        if (buttons[i].Bounds.Contains(p)) return i;
      }
      return -1;
    }

    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        if (!hole) cp.ClassStyle |= 0x00020000;
        cp.ExStyle |= 0x00000080;
        return cp;
      }
    }

    void SaveImage(object sender, EventArgs e) {
      SaveFileDialog dialog = new SaveFileDialog();
      dialog.Filter = "PNG 图片|*.png";
      dialog.FileName = "截图 " + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png";
      TopMost = false;
      DialogResult result = dialog.ShowDialog(this);
      TopMost = true;
      if (result != DialogResult.OK) return;
      try {
        image.Save(dialog.FileName, ImageFormat.Png);
        Flash("已保存");
      } catch (Exception) {
        Flash("保存失败");
      }
    }

    protected override void OnFormClosed(FormClosedEventArgs e) {
      flashTimer.Stop();
      flashTimer.Dispose();
      image.Dispose();
      uiFont.Dispose();
      if (iconFont != null) iconFont.Dispose();
      base.OnFormClosed(e);
    }

    protected override void OnActivated(EventArgs e) {
      base.OnActivated(e);
      Invalidate();
    }

    protected override void OnDeactivate(EventArgs e) {
      base.OnDeactivate(e);
      Invalidate();
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
      if (keyData == Keys.Escape) {
        if (drawing && tool == ToolRect) {
          drawing = false;
          Invalidate();
          return true;
        }
        drawing = false;
        if (tool != 0) {
          tool = 0;
          Invalidate();
          return true;
        }
        Close();
        return true;
      }
      if (keyData == (Keys.Control | Keys.C)) {
        CopyImage(image);
        Close();
        return true;
      }
      if (keyData == (Keys.Control | Keys.S)) {
        SaveImage(this, EventArgs.Empty);
        return true;
      }
      return base.ProcessCmdKey(ref msg, keyData);
    }

    void BeginMove() {
      moving = true;
      moveCursor = MousePosition;
      moveOrigin = Location;
    }

    protected override void OnMouseDown(MouseEventArgs e) {
      if (e.Button == MouseButtons.Left) {
        int hit = HitButton(e.Location);
        if (hit >= 0) {
          pressIndex = hit;
          Invalidate();
        } else if (tool != 0 && OverImage(e.Location)) {
          Point img = ToImage(e.Location);
          drawing = true;
          drawLast = img;
          shapeA = img;
          shapeB = img;
          if (tool == ToolPen) PaintDot(img);
          Invalidate();
        } else {
          BeginMove();
        }
      }
      base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e) {
      if (drawing) {
        Point img = ToImage(e.Location);
        if (tool == ToolPen) {
          if (img != drawLast) {
            PaintStroke(drawLast, img);
            drawLast = img;
          }
        } else {
          shapeB = img;
        }
        Invalidate();
      } else if (moving) {
        Location = new Point(
          moveOrigin.X + MousePosition.X - moveCursor.X,
          moveOrigin.Y + MousePosition.Y - moveCursor.Y);
      } else {
        int hit = HitButton(e.Location);
        if (hit != hoverIndex) {
          hoverIndex = hit;
          Invalidate();
        }
        bool drawCursor = tool != 0 && OverImage(e.Location);
        Cursor = hit >= 0 ? Cursors.Hand : (drawCursor ? Cursors.Cross : (e.Y < barTop ? Cursors.SizeAll : Cursors.Default));
      }
      base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e) {
      if (drawing && e.Button == MouseButtons.Left) {
        Point img = ToImage(e.Location);
        if (tool == ToolPen) {
          if (img != drawLast) PaintStroke(drawLast, img);
        } else if (tool == ToolRect) {
          shapeB = img;
          CommitRect(BoxOf(shapeA, shapeB));
        }
        drawing = false;
        Invalidate();
        return;
      }
      moving = false;
      if (pressIndex >= 0 && e.Button == MouseButtons.Left) {
        int pressed = pressIndex;
        pressIndex = -1;
        Invalidate();
        if (HitButton(e.Location) == pressed) {
          buttons[pressed].Click(this, EventArgs.Empty);
          return;
        }
      }
      base.OnMouseUp(e);
    }

    protected override void OnMouseLeave(EventArgs e) {
      if (hoverIndex >= 0) {
        hoverIndex = -1;
        Invalidate();
      }
      base.OnMouseLeave(e);
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e) {
      if (e.Button == MouseButtons.Left && e.Y < barTop && tool == 0 && HitButton(e.Location) < 0) {
        Close();
        return;
      }
      base.OnMouseDoubleClick(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
      Graphics g = e.Graphics;
      int width = ClientSize.Width;
      int height = ClientSize.Height;
      g.Clear(BackColor);

      bool scaled = imageWidth != image.Width || imageHeight != image.Height;
      g.InterpolationMode = scaled ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      g.DrawImage(image, new Rectangle(1, 1, imageWidth, imageHeight));
      g.PixelOffsetMode = PixelOffsetMode.Default;
      if (hole) {
        using (SolidBrush key = new SolidBrush(HoleKey)) {
          g.FillRectangle(key, imageWidth + 2, 0, width - imageWidth - 2, barTop);
        }
      }

      if (drawing && tool == ToolRect) {
        Rectangle live = ToClientRect(BoxOf(shapeA, shapeB));
        if (live.Width >= 2 || live.Height >= 2) {
          SmoothingMode old = g.SmoothingMode;
          g.SmoothingMode = SmoothingMode.AntiAlias;
          using (Pen mark = new Pen(Ink, Math.Max(2f, 3f * scale))) {
            mark.Alignment = PenAlignment.Inset;
            g.DrawRectangle(mark, live);
          }
          g.SmoothingMode = old;
        }
      }

      using (SolidBrush bar = new SolidBrush(Color.FromArgb(28, 33, 40))) {
        g.FillRectangle(bar, 1, barTop, width - 2, barHeight - 1);
      }
      using (Pen line = new Pen(Color.FromArgb(38, 255, 255, 255), 1)) {
        g.DrawLine(line, 1, barTop, width - 2, barTop);
      }

      string left = flash.Length > 0 ? flash : image.Width.ToString() + " × " + image.Height.ToString();
      Color leftColor = flash.Length > 0 ? SnipAccent : SnipMuted;
      if (compact && hoverIndex >= 0 && flash.Length == 0) {
        left = buttons[hoverIndex].Label;
        leftColor = SnipInk;
      }
      int leftEnd = buttons.Count > 0 ? buttons[0].Bounds.X - S(8) : width - S(8);
      Rectangle leftRect = new Rectangle(S(12), barTop, leftEnd - S(12), barHeight);
      if (leftRect.Width > S(24)) {
        TextRenderer.DrawText(g, left, uiFont, leftRect, leftColor, SnipText | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
      }

      for (int i = 0; i < buttons.Count; i++) {
        PinButton b = buttons[i];
        bool hot = i == hoverIndex;
        bool down = hot && i == pressIndex;
        bool selected = b.ToolId != 0 && b.ToolId == tool;
        if (hot || selected) {
          SmoothingMode old = g.SmoothingMode;
          g.SmoothingMode = SmoothingMode.AntiAlias;
          Color back = b.Danger
            ? Color.FromArgb(down ? 120 : 80, 239, 68, 68)
            : selected
              ? Color.FromArgb(down ? 210 : 170, 239, 68, 68)
              : Color.FromArgb(down ? 64 : 36, 255, 255, 255);
          using (GraphicsPath path = RoundedRect(b.Bounds, S(6)))
          using (SolidBrush fill = new SolidBrush(back)) {
            g.FillPath(fill, path);
          }
          g.SmoothingMode = old;
        }
        Color fg = (selected || (hot && b.Danger)) ? Color.White : SnipInk;
        if (compact) {
          TextRenderer.DrawText(g, b.Glyph, iconFont, b.Bounds, fg, SnipText | TextFormatFlags.HorizontalCenter);
          continue;
        }
        int x = b.Bounds.X + S(8);
        if (iconFont != null) {
          Rectangle icon = new Rectangle(x, b.Bounds.Y, S(16), b.Bounds.Height);
          TextRenderer.DrawText(g, b.Glyph, iconFont, icon, fg, SnipText | TextFormatFlags.HorizontalCenter);
          x += S(18);
        }
        Rectangle label = new Rectangle(x, b.Bounds.Y, b.Bounds.Right - x, b.Bounds.Height);
        TextRenderer.DrawText(g, b.Label, uiFont, label, fg, SnipText | TextFormatFlags.Left);
      }

      Color edge = ContainsFocus ? SnipAccent : Color.FromArgb(72, 84, 98);
      using (Pen border = new Pen(edge, 1)) {
        if (hole) {
          int ir = imageWidth + 1;
          g.DrawLines(border, new Point[] {
            new Point(0, 0), new Point(ir, 0), new Point(ir, barTop),
            new Point(width - 1, barTop), new Point(width - 1, height - 1),
            new Point(0, height - 1), new Point(0, 0)
          });
        } else {
          g.DrawRectangle(border, 0, 0, width - 1, height - 1);
        }
      }
    }
  }
}
