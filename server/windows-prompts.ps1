param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Prepare', 'Credential', 'ConfirmHost', 'RetryCredential', 'ChoosePrivateKey', 'KeyPassphrase')]
    [string]$Mode,
    [string]$HostName,
    [int]$Port = 22,
    [string]$UserName,
    [string]$Fingerprint,
    [int]$Attempt = 1,
    [string]$PromptMessage = ''
)

$ErrorActionPreference = 'Stop'

function Write-JsonLine($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
}

if (-not ('CodexSshNative' -as [type])) {
    $nativeHelperPath = Join-Path $env:APPDATA 'CodexSSH\CodexSshNative.v1.dll'
    if (Test-Path -LiteralPath $nativeHelperPath) {
        Add-Type -Path $nativeHelperPath
    } else {
        $nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexSshNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDUI_INFO {
        public int cbSize;
        public IntPtr hwndParent;
        public string pszMessageText;
        public string pszCaptionText;
        public IntPtr hbmBanner;
    }

    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    public static extern int CredUIPromptForCredentials(
        ref CREDUI_INFO pUiInfo,
        string pszTargetName,
        IntPtr reserved,
        int dwAuthError,
        StringBuilder pszUserName,
        int ulUserNameMaxChars,
        StringBuilder pszPassword,
        int ulPasswordMaxChars,
        ref bool pfSave,
        int dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
'@
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $nativeHelperPath) | Out-Null
        try {
            Add-Type -TypeDefinition $nativeSource -OutputAssembly $nativeHelperPath
        } catch {
            Add-Type -TypeDefinition $nativeSource
        }
    }
}

switch ($Mode) {
    'Prepare' {
        Write-JsonLine @{ ready = $true }
        break
    }

    'ChoosePrivateKey' {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        if ([string]::IsNullOrWhiteSpace($UserName) -and [string]::IsNullOrWhiteSpace($HostName)) {
            $dialog.Title = 'Choose the default SSH private key stored on this PC'
        } else {
            $dialog.Title = "Choose a private key stored on this PC for $UserName@$HostName`:$Port"
        }
        $dialog.Filter = 'SSH private key files|id_*;*.pem;*.key;*.ppk|All files (*.*)|*.*'
        $dialog.CheckFileExists = $true
        $dialog.Multiselect = $false
        $dialog.RestoreDirectory = $true
        $sshDirectory = Join-Path $env:USERPROFILE '.ssh'
        if (Test-Path -LiteralPath $sshDirectory -PathType Container) { $dialog.InitialDirectory = $sshDirectory }
        $choice = $dialog.ShowDialog()
        if ($choice -ne [System.Windows.Forms.DialogResult]::OK) {
            Write-JsonLine @{ cancelled = $true }
        } else {
            Write-JsonLine @{ cancelled = $false; path = $dialog.FileName }
        }
        $dialog.Dispose()
        break
    }

    'KeyPassphrase' {
        Add-Type -AssemblyName System.Windows.Forms
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Codex SSH - Unlock local private key'
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(460, 170)

        $label = New-Object System.Windows.Forms.Label
        $label.AutoSize = $false
        $label.Location = New-Object System.Drawing.Point(18, 16)
        $label.Size = New-Object System.Drawing.Size(424, 46)
        $message = if ($PromptMessage) { "$PromptMessage`n" } else { '' }
        $label.Text = "${message}Enter the passphrase for the local SSH key used by $UserName@$HostName`:$Port. It will not be saved."

        $secretBox = New-Object System.Windows.Forms.TextBox
        $secretBox.Location = New-Object System.Drawing.Point(18, 70)
        $secretBox.Size = New-Object System.Drawing.Size(424, 26)
        $secretBox.UseSystemPasswordChar = $true

        $ok = New-Object System.Windows.Forms.Button
        $ok.Text = 'OK'
        $ok.Location = New-Object System.Drawing.Point(254, 118)
        $ok.Size = New-Object System.Drawing.Size(88, 30)
        $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK

        $cancel = New-Object System.Windows.Forms.Button
        $cancel.Text = 'Cancel'
        $cancel.Location = New-Object System.Drawing.Point(354, 118)
        $cancel.Size = New-Object System.Drawing.Size(88, 30)
        $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

        $form.Controls.Add($label)
        $form.Controls.Add($secretBox)
        $form.Controls.Add($ok)
        $form.Controls.Add($cancel)
        $form.AcceptButton = $ok
        $form.CancelButton = $cancel
        $form.Add_Shown({ $secretBox.Select() })
        $choice = $form.ShowDialog()
        if ($choice -ne [System.Windows.Forms.DialogResult]::OK) {
            Write-JsonLine @{ cancelled = $true }
        } else {
            $secret = $secretBox.Text
            $secretBox.Clear()
            Write-JsonLine @{ cancelled = $false; passphrase = $secret }
            $secret = $null
        }
        $form.Dispose()
        break
    }

    'Credential' {
        $info = New-Object CodexSshNative+CREDUI_INFO
        $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CodexSshNative+CREDUI_INFO])
        $info.hwndParent = [CodexSshNative]::GetForegroundWindow()
        $info.pszCaptionText = 'Codex SSH - Enter server password'
        $prefix = if ($PromptMessage) { "$PromptMessage`n`n" } else { '' }
        $info.pszMessageText = "${prefix}Enter the SSH password for $UserName@$HostName`:$Port. Attempt $Attempt of 5. Do not enable credential saving."

        $userBuffer = [System.Text.StringBuilder]::new($UserName, 256)
        $passwordBuffer = [System.Text.StringBuilder]::new(512)
        $save = $false
        $flags = 0x40000 -bor 0x2 -bor 0x80 -bor 0x8
        $target = "Codex SSH $UserName@$HostName`:$Port"
        $result = [CodexSshNative]::CredUIPromptForCredentials(
            [ref]$info,
            $target,
            [IntPtr]::Zero,
            0,
            $userBuffer,
            $userBuffer.Capacity,
            $passwordBuffer,
            $passwordBuffer.Capacity,
            [ref]$save,
            $flags)

        if ($result -eq 1223) {
            $passwordBuffer.Clear() | Out-Null
            Write-JsonLine @{ cancelled = $true }
            break
        }
        if ($result -ne 0) {
            throw "Windows credential dialog failed with code $result."
        }

        $secret = $passwordBuffer.ToString()
        $enteredUser = $userBuffer.ToString()
        $passwordBuffer.Clear() | Out-Null
        Write-JsonLine @{ cancelled = $false; username = $enteredUser; password = $secret }
        $secret = $null
        break
    }

    'ConfirmHost' {
        $body = "Host: $HostName`:$Port`nFingerprint: $Fingerprint`n`nVerify this fingerprint with your server administrator before trusting it. Trust and remember this host key?"
        $flags = 0x4 -bor 0x30 -bor 0x100 -bor 0x40000
        $choice = [CodexSshNative]::MessageBox([IntPtr]::Zero, $body, 'Codex SSH - Verify server identity', [uint32]$flags)
        Write-JsonLine @{ approved = ($choice -eq 6) }
        break
    }

    'RetryCredential' {
        $body = "$PromptMessage`n`nHost: $UserName@$HostName`:$Port`n`nOpen the password window again?"
        $flags = 0x4 -bor 0x30 -bor 0x100 -bor 0x40000
        $choice = [CodexSshNative]::MessageBox([CodexSshNative]::GetForegroundWindow(), $body, 'Codex SSH - Try again', [uint32]$flags)
        Write-JsonLine @{ retry = ($choice -eq 6) }
        break
    }

}
