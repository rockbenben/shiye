# ENCODING: keep the UTF-8 BOM (this file's first 3 bytes must be EF BB BF).
# Do not re-save as "UTF-8 without BOM" or run through a formatter that strips it.
# 本文件开头必须保留 UTF-8 BOM——实测：这台机器代码页 936（GBK），Windows PowerShell 5.1
# 没有 BOM 时会按 GBK 解析本文件，把下面的中文注释解码错乱，进而把 if/else 解析坏掉
# （报错甚至会指向错误的行号），跟下面 AppId 那条一样是「不报错、也不显示，最难查的那种
# 坏法」——而且已经在这台机器上真实发生过一次。server/src/reminder.test.ts 里有个字节
# 级测试守着这件事：BOM 被删掉它就会红。
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = ''
)

# Windows 原生 toast，零 npm 依赖。
#
# AppId 必须是一台机器上真实注册过的 AUMID，否则通知会被系统静默丢掉——
# 不报错、也不显示，最难查的那种坏法。这里用 Windows PowerShell 自己的 AUMID，
# 它在 Win10/11 上一律存在。想换成自己的（比如装了 Windows Terminal）
# 就设环境变量 TOAST_APPID。
$appId = if ($env:TOAST_APPID) { $env:TOAST_APPID }
         else { '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
  [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $template.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
$nodes.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null

$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
