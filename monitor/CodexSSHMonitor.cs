using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class SessionSnapshot
{
    public string statusId { get; set; }
    public string chatLabel { get; set; }
    public string authMethod { get; set; }
    public string host { get; set; }
    public string username { get; set; }
    public int port { get; set; }
    public string state { get; set; }
    public long connectedAt { get; set; }
    public long lastActivityAt { get; set; }
    public string lastAction { get; set; }
}

public sealed class PendingSnapshot
{
    public string pendingId { get; set; }
    public string chatLabel { get; set; }
    public string authMethod { get; set; }
    public string host { get; set; }
    public string username { get; set; }
    public int port { get; set; }
    public string state { get; set; }
    public long startedAt { get; set; }
}

public sealed class ProcessSnapshot
{
    public int processId { get; set; }
    public string processLabel { get; set; }
    public string processState { get; set; }
    public long processStartedAt { get; set; }
    public long updatedAt { get; set; }
    public List<SessionSnapshot> sessions { get; set; }
    public List<PendingSnapshot> pendingConnections { get; set; }
}

public sealed class CodexSshMonitorForm : Form
{
    private readonly string statusDirectory;
    private readonly string labelOverridesPath;
    private readonly Dictionary<string, string> labelOverrides = new Dictionary<string, string>();
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private readonly DataGridView grid = new DataGridView();
    private readonly Label summary = new Label();
    private readonly Label help = new Label();
    private readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer();

    public CodexSshMonitorForm()
    {
        Text = "Codex SSH Monitor";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(820, 430);
        Size = new Size(980, 540);
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.FromArgb(248, 250, 252);

        statusDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "CodexSSH", "status");
        labelOverridesPath = Path.Combine(Path.GetDirectoryName(statusDirectory), "chat-labels.json");
        LoadLabelOverrides();

        var header = new Panel { Dock = DockStyle.Top, Height = 82, Padding = new Padding(18, 12, 18, 8), BackColor = Color.White };
        summary.Dock = DockStyle.Top;
        summary.Height = 28;
        summary.Font = new Font("Segoe UI Semibold", 13F, FontStyle.Bold);
        summary.Text = "正在读取本机 SSH 状态…";
        help.Dock = DockStyle.Top;
        help.Height = 28;
        help.ForeColor = Color.FromArgb(89, 100, 116);
        help.Text = "SSH 连接会自动匹配 Codex 聊天标题；旧连接从本机历史回填。";
        header.Controls.Add(help);
        header.Controls.Add(summary);

        grid.Dock = DockStyle.Fill;
        grid.ReadOnly = true;
        grid.AllowUserToAddRows = false;
        grid.AllowUserToDeleteRows = false;
        grid.AllowUserToResizeRows = false;
        grid.RowHeadersVisible = false;
        grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        grid.BackgroundColor = Color.White;
        grid.BorderStyle = BorderStyle.None;
        grid.EnableHeadersVisualStyles = false;
        grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(240, 244, 249);
        grid.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(35, 45, 60);
        grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 9F, FontStyle.Bold);
        grid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(222, 235, 250);
        grid.DefaultCellStyle.SelectionForeColor = Color.FromArgb(25, 35, 50);
        AddColumn("chatLabel", "聊天标题", 2.4F);
        grid.Columns["chatLabel"].HeaderCell.ToolTipText = "优先显示 Codex 侧边栏聊天标题；悬停可查看完整标题。";
        AddColumn("host", "服务器", 1.75F);
        AddColumn("username", "用户", 0.95F);
        AddColumn("port", "端口", 0.6F);
        AddColumn("auth", "认证", 0.75F);
        AddColumn("state", "状态", 1.0F);
        AddColumn("connected", "连接时间", 1.2F);
        AddColumn("activity", "最近活动", 1.2F);
        AddColumn("action", "当前/最近操作", 1.35F);
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 54, Padding = new Padding(14, 8, 14, 8), BackColor = Color.White };
        var openFolder = new Button { Text = "打开状态目录", Width = 120, Height = 30, Dock = DockStyle.Right, FlatStyle = FlatStyle.System };
        openFolder.Click += (sender, args) =>
        {
            try
            {
                Directory.CreateDirectory(statusDirectory);
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + statusDirectory + "\"",
                    UseShellExecute = true,
                });
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "无法打开目录", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        };
        var refresh = new Button { Text = "立即刷新", Width = 100, Height = 30, Dock = DockStyle.Right, FlatStyle = FlatStyle.System };
        refresh.Click += (sender, args) => RefreshStatus();
        footer.Controls.Add(openFolder);
        footer.Controls.Add(refresh);

        Controls.Add(grid);
        Controls.Add(footer);
        Controls.Add(header);

        refreshTimer.Interval = 2000;
        refreshTimer.Tick += (sender, args) => RefreshStatus();
        Shown += (sender, args) =>
        {
            Directory.CreateDirectory(statusDirectory);
            RefreshStatus();
            refreshTimer.Start();
        };
        FormClosed += (sender, args) => refreshTimer.Stop();
    }

    private void AddColumn(string name, string title, float fillWeight)
    {
        grid.Columns.Add(new DataGridViewTextBoxColumn { Name = name, HeaderText = title, FillWeight = fillWeight, SortMode = DataGridViewColumnSortMode.NotSortable });
    }

    private static string LocalTime(long timestamp)
    {
        if (timestamp <= 0) return "—";
        try { return DateTimeOffset.FromUnixTimeMilliseconds(timestamp).ToLocalTime().ToString("HH:mm:ss"); }
        catch { return "—"; }
    }

    private static string TranslateState(string state, bool online)
    {
        if (!online) return "MCP 离线";
        if (state == "busy") return "执行中";
        if (state == "connected") return "已连接";
        if (String.IsNullOrEmpty(state)) return "运行中";
        if (state.Contains("password") || state.Contains("SSH")) return "连接中";
        return state;
    }

    private static string DisplayLabel(string chatLabel, string processLabel, int processId)
    {
        if (!String.IsNullOrWhiteSpace(chatLabel)) return chatLabel;
        if (!String.IsNullOrWhiteSpace(processLabel)) return processLabel;
        if (processId > 0)
        {
            string id = processId.ToString("X");
            if (id.Length > 6) id = id.Substring(id.Length - 6);
            return "窗口-" + id.PadLeft(6, '0');
        }
        return "—";
    }

    private static string MakeKey(params string[] parts)
    {
        using (var sha = SHA256.Create())
        {
            byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(String.Join("\u001f", parts)));
            var result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) result.Append(value.ToString("x2"));
            return result.ToString();
        }
    }

    private static string SessionKey(ProcessSnapshot snapshot, SessionSnapshot session)
    {
        if (!String.IsNullOrWhiteSpace(session.statusId)) return MakeKey("session", session.statusId);
        return MakeKey("legacy-session", snapshot.processId.ToString(), session.host, session.username, session.port.ToString(), session.connectedAt.ToString());
    }

    private static string PendingKey(ProcessSnapshot snapshot, PendingSnapshot pending)
    {
        if (!String.IsNullOrWhiteSpace(pending.pendingId)) return MakeKey("pending", pending.pendingId);
        return MakeKey("legacy-pending", snapshot.processId.ToString(), pending.host, pending.username, pending.port.ToString(), pending.startedAt.ToString());
    }

    private string ResolveLabel(string key, string fallback)
    {
        string custom;
        return labelOverrides.TryGetValue(key, out custom) ? custom : fallback;
    }

    private void LoadLabelOverrides()
    {
        labelOverrides.Clear();
        try
        {
            if (!File.Exists(labelOverridesPath)) return;
            var loaded = serializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(labelOverridesPath));
            if (loaded == null) return;
            foreach (var entry in loaded)
            {
                if (!String.IsNullOrWhiteSpace(entry.Key) && !String.IsNullOrWhiteSpace(entry.Value))
                    labelOverrides[entry.Key] = entry.Value;
            }
        }
        catch
        {
            // A damaged local override file must not prevent the monitor from opening.
        }
    }

    private void RefreshStatus()
    {
        var rows = new List<object[]>();
        int liveServers = 0;
        int liveSessions = 0;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        LoadLabelOverrides();

        try
        {
            Directory.CreateDirectory(statusDirectory);
            foreach (string file in Directory.GetFiles(statusDirectory, "mcp-*.json"))
            {
                ProcessSnapshot snapshot;
                try { snapshot = serializer.Deserialize<ProcessSnapshot>(File.ReadAllText(file)); }
                catch { continue; }
                if (snapshot == null) continue;

                bool online = snapshot.processState == "running" && now - snapshot.updatedAt < 15000;
                if (online) liveServers++;

                var sessions = snapshot.sessions ?? new List<SessionSnapshot>();
                var pending = snapshot.pendingConnections ?? new List<PendingSnapshot>();
                foreach (var item in pending)
                {
                    if (!online) continue;
                    string key = PendingKey(snapshot, item);
                    string auth = item.authMethod == "privateKey" ? "本机私钥" : item.authMethod == "password" ? "密码" : "—";
                    rows.Add(new object[] { ResolveLabel(key, DisplayLabel(item.chatLabel, snapshot.processLabel, snapshot.processId)), item.host, item.username, item.port, auth, "登录/连接中", "—", LocalTime(item.startedAt), item.state });
                }
                foreach (var item in sessions)
                {
                    if (!online) continue;
                    liveSessions++;
                    string key = SessionKey(snapshot, item);
                    string auth = item.authMethod == "privateKey" ? "本机私钥" : item.authMethod == "password" ? "密码" : "—";
                    rows.Add(new object[] { ResolveLabel(key, DisplayLabel(item.chatLabel, snapshot.processLabel, snapshot.processId)), item.host, item.username, item.port, auth, TranslateState(item.state, online), LocalTime(item.connectedAt), LocalTime(item.lastActivityAt), item.lastAction });
                }
            }
        }
        catch (Exception ex)
        {
            summary.Text = "读取 SSH 状态失败";
            help.Text = ex.Message;
            return;
        }

        grid.Rows.Clear();
        foreach (var row in rows)
        {
            int rowIndex = grid.Rows.Add(row);
            grid.Rows[rowIndex].Cells["chatLabel"].ToolTipText = Convert.ToString(row[0]);
        }
        summary.Text = liveSessions > 0
            ? String.Format("在线：{0} 个 SSH 连接　·　{1} 个本机 MCP 进程", liveSessions, liveServers)
            : liveServers > 0 ? "MCP 已运行，当前没有 SSH 连接" : "等待 Codex 启动本机 SSH MCP 服务";
        help.Text = String.Format("每 2 秒刷新　·　最近更新 {0}　·　仅显示在线 SSH 及登录中会话　·　状态目录：{1}", DateTime.Now.ToString("HH:mm:ss"), statusDirectory);
    }
}

public static class Program
{
    private const int ShowRestore = 9;

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    private static void ActivateExistingWindow()
    {
        IntPtr window = FindWindow(null, "Codex SSH Monitor");
        if (window == IntPtr.Zero) return;
        ShowWindow(window, ShowRestore);
        SetForegroundWindow(window);
    }

    [STAThread]
    public static void Main()
    {
        bool createdNew;
        using (var mutex = new System.Threading.Mutex(true, "Local\\CodexSSHMonitor.SingleInstance", out createdNew))
        {
            if (!createdNew)
            {
                ActivateExistingWindow();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new CodexSshMonitorForm());
        }
    }
}
