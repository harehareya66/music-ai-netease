param(
  [string]$BaseUrl = 'http://127.0.0.1:7789/music',
  [int]$FontSize = 26,
  [int]$Lines = 3,
  [switch]$Locked,
  [int]$X = -1,
  [int]$Y = -1,
  [string]$StateFile = '',
  [string]$ContentFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing


# Windows PowerShell 5.1 会把 UTF-8 的 JSON 当 ANSI 解，中文全变问号 —— 自己按字节解码。
function Get-Json([string]$Url) {
  $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8
  $text = [System.Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
  return $text | ConvertFrom-Json
}

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class LyricDesktopWindow : Form
{
    public string[] Lines = new string[0];
    public int Current = 0;
    public string Title = "";
    public int FontSize = 26;
    public bool ClickThrough = false;
    public string StatusText = "";

    private bool dragging = false;
    private Point dragStart;
    private Point formStart;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_LAYERED = 0x80000;
    private const int WS_EX_TRANSPARENT = 0x20;
    private const int WS_EX_TOOLWINDOW = 0x80;

    public LyricDesktopWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;
        TransparencyKey = Color.Black;
        DoubleBuffered = true;
        Size = new Size(680, 250);
        Text = "桌面歌词";
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    public void SetClickThrough(bool on)
    {
        ClickThrough = on;
        /* TransparencyKey 已经让窗口成为 layered；这里只切换命中测试位，不再动
           WS_EX_LAYERED，否则会把窗口变回整块不透明黑底。 */
        int style = GetWindowLong(Handle, GWL_EXSTYLE);
        if (on) style |= WS_EX_TRANSPARENT;
        else style &= ~WS_EX_TRANSPARENT;
        SetWindowLong(Handle, GWL_EXSTYLE, style);
        Invalidate();
    }

    public void ApplyLock(bool on)
    {
        SetClickThrough(on);
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Left && !ClickThrough)
        {
            dragging = true;
            dragStart = Cursor.Position;
            formStart = Location;
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (dragging)
        {
            Point now = Cursor.Position;
            Location = new Point(formStart.X + now.X - dragStart.X, formStart.Y + now.Y - dragStart.Y);
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        dragging = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;

        int width = ClientSize.Width;
        int centerY = ClientSize.Height / 2;

        using (Font titleFont = new Font("Microsoft YaHei UI", 10f, FontStyle.Regular))
        using (SolidBrush dim = new SolidBrush(Color.FromArgb(170, 178, 184)))
        {
            if (!string.IsNullOrEmpty(Title))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(Title, titleFont, dim, new RectangleF(0, 8, width, 20), sf);
            }
        }

        if (Lines == null || Lines.Length == 0)
        {
            using (Font f = new Font("Microsoft YaHei UI", 13f))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(200, 200, 205)))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(StatusText.Length > 0 ? StatusText : "正在等播放器…", f, b, new RectangleF(0, centerY - 20, width, 40), sf);
            }
            return;
        }

        int count = Lines.Length;
        float currentSize = FontSize;
        float sideSize = FontSize * 0.62f;
        float spacing = 8f;

        float total = currentSize + (count - 1) * sideSize + (count - 1) * spacing;
        float y = centerY - total / 2f;

        StringFormat format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Near, Trimming = StringTrimming.EllipsisCharacter };

        for (int i = 0; i < count; i++)
        {
            bool isCurrent = i == 0;
            float size = isCurrent ? currentSize : sideSize;
            Color color = isCurrent ? Color.FromArgb(229, 72, 77) : Color.FromArgb(185, 188, 195);
            using (Font font = new Font("Microsoft YaHei UI", size / 1.35f, isCurrent ? FontStyle.Bold : FontStyle.Regular))
            using (SolidBrush brush = new SolidBrush(color))
            {
                RectangleF box = new RectangleF(16, y, width - 32, size + 16);
                g.DrawString(Lines[i], font, brush, box, format);
            }
            y += size + spacing;
        }

        if (ClickThrough)
        {
            using (Font f = new Font("Microsoft YaHei UI", 8.5f))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(120, 130, 138)))
            {
                g.DrawString("已锁定 · 双击歌词区解锁", f, b, new PointF(14, ClientSize.Height - 20));
            }
        }
    }

    protected override void OnDoubleClick(EventArgs e)
    {
        base.OnDoubleClick(e);
        if (ClickThrough)
        {
            SetClickThrough(false);
            return;
        }
        SetClickThrough(true);
    }
}
'@

$form = New-Object LyricDesktopWindow
$form.FontSize = $FontSize
$form.Text = '桌面歌词'
$form.ApplyLock($Locked.IsPresent)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$lockItem = New-Object System.Windows.Forms.ToolStripMenuItem
$lockItem.Text = '锁定（点击穿透）'
$lockItem.Add_Click({
  $form.SetClickThrough(-not $form.ClickThrough)
  $lockItem.Text = if ($form.ClickThrough) { '解锁（恢复鼠标）' } else { '锁定（点击穿透）' }
})
$fontUp = New-Object System.Windows.Forms.ToolStripMenuItem
$fontUp.Text = '字号 +2'
$fontUp.Add_Click({ $form.FontSize = [Math]::Min(48, $form.FontSize + 2); $form.Invalidate() })
$fontDown = New-Object System.Windows.Forms.ToolStripMenuItem
$fontDown.Text = '字号 -2'
$fontDown.Add_Click({ $form.FontSize = [Math]::Max(14, $form.FontSize - 2); $form.Invalidate() })
$close = New-Object System.Windows.Forms.ToolStripMenuItem
$close.Text = '关闭桌面歌词'
$close.Add_Click({ $form.Close() })
$open = New-Object System.Windows.Forms.ToolStripMenuItem
$open.Text = '打开播放器'
$open.Add_Click({ Start-Process "$BaseUrl/panel" })
[void]$menu.Items.Add($lockItem)
[void]$menu.Items.Add($fontUp)
[void]$menu.Items.Add($fontDown)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($open)
[void]$menu.Items.Add($close)
$form.ContextMenuStrip = $menu

$form.Show()

# 放到任务栏上方居中（或调用方指定的位置）；Show 之后按窗体所在屏幕夹紧，
# 避免高 DPI 下算出屏幕外的坐标。
$area = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
if ($X -lt 0) { $X = $area.Left + [int](($area.Width - $form.Width) / 2) }
if ($Y -lt 0) { $Y = $area.Top + [int]($area.Height * 0.66) }
$X = [Math]::Min([Math]::Max($area.Left, $X), [Math]::Max($area.Left, $area.Right - $form.Width))
$Y = [Math]::Min([Math]::Max($area.Top, $Y), [Math]::Max($area.Top, $area.Bottom - $form.Height))
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.TopMost = $true
if ($Locked) { $form.ApplyLock($true) }

# 启动器是 `cmd /c start`，拿不到子进程 PID，只能由窗口自己把真实 PID 写回去。
if ($StateFile) {
  try { Set-Content -Path $StateFile -Value $PID -Encoding ASCII } catch {}
}

$contentFile = $ContentFile
while (-not $form.IsDisposed) {
  # Node 侧已经算好「标题 + 当前 3/5 行」，这里只负责画：PowerShell 不碰 HTTP 和 JSON 编码。
  if ($contentFile -and (Test-Path $contentFile)) {
    try {
      $raw = Get-Content -Path $contentFile -Raw -Encoding UTF8
      $content = $raw | ConvertFrom-Json
      $form.Title = [string]$content.title
      $form.StatusText = [string]$content.status
      $next = @()
      if ($content.lines) { $next = @($content.lines | ForEach-Object { [string]$_ }) }
      if (($next -join "`n") -ne ($form.Lines -join "`n") -or $form.StatusText -ne $script:lastStatus) {
        $form.Lines = $next
        $script:lastStatus = $form.StatusText
        $form.Invalidate()
      }
    } catch {}
  }
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 400
}
