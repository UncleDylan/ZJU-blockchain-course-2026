param(
    [string]$SSHHost = 'Ubuntu-64-bit',
    [string]$UbuntuProjectPath = '/mnt/hgfs/VMware_Shared_Folder/Blockchain/hw2/ZJU-blockchain-course-2026'
)
$ErrorActionPreference = 'Stop'

if ($UbuntuProjectPath -notmatch '^/[A-Za-z0-9_./-]+$') {
    throw 'UbuntuProjectPath must be an absolute path without spaces or shell special characters.'
}
if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) { throw 'Windows OpenSSH client is missing.' }

Write-Host 'Waiting for Ubuntu SSH. Please start the virtual machine first.'
$sshReady = $false
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try {
        & ssh.exe -o BatchMode=yes -o ConnectTimeout=3 -o ConnectionAttempts=1 $SSHHost true 2>$null
        if ($LASTEXITCODE -eq 0) { $sshReady = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $sshReady) { throw "Cannot connect to $SSHHost. Check the VM and your SSH configuration." }

# Strip possible CRLF in memory; Windows Git may check shell scripts out with CRLF.
& ssh.exe $SSHHost "cd '$UbuntuProjectPath' && tr -d '\r' < tools/start-dev.sh | bash -s -- '$UbuntuProjectPath'"
if ($LASTEXITCODE -ne 0) { throw 'Ubuntu startup failed. Read the error above; no tunnel was started.' }

$sshAddress = @(& ssh.exe -G $SSHHost) | Select-String '^hostname\s+(.+)$' | Select-Object -First 1
$vmAddress = if ($sshAddress) { $sshAddress.Matches[0].Groups[1].Value.Trim() } else { $SSHHost }
Write-Host "Frontend: http://${vmAddress}:3000"
Write-Host 'Wallet RPC: http://127.0.0.1:8545   Chain ID: 31337'

$listener = Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $rpc = Invoke-RestMethod -Uri 'http://127.0.0.1:8545' -Method Post -ContentType 'application/json' `
            -Body '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' -TimeoutSec 5
        if ($rpc.result -ne '0x7a69') { throw 'Unexpected chain.' }
    } catch { throw 'Windows port 8545 is occupied but RPC is unhealthy. Close the old tunnel window, then rerun this script.' }
    Write-Host 'An existing local RPC connection is healthy. Keep its tunnel window open.'
    return
}

Write-Host 'Starting wallet RPC tunnel. KEEP THIS WINDOW OPEN while using MiniDEX.'
Write-Host 'Press Ctrl+C when finished. Closing this window disconnects the wallet RPC.'
& ssh.exe -N -L 127.0.0.1:8545:127.0.0.1:8545 -o ExitOnForwardFailure=yes `
    -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 $SSHHost
if ($LASTEXITCODE -ne 0) { throw 'RPC tunnel stopped unexpectedly. Check the VM and rerun this script.' }
