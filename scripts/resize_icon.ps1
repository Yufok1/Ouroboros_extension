Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('F:\End-Game\vscode-extension\resources\icon.png')
$bmp = New-Object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, 256, 256)
$bmp.Save('F:\End-Game\vscode-extension\resources\icon_small.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$img.Dispose()
Write-Host "Saved 256x256 icon"
