$sourceDir = $PSScriptRoot
$outputFile = Join-Path $sourceDir "2026.1.28txt"

Write-Host "Source Dir: $sourceDir"
Write-Host "Output File: $outputFile"

# Clear content of the output file or create it
$null = New-Item -Path $outputFile -ItemType File -Force

# Get files with "copy" in the name, sort by Name descending
$files = Get-ChildItem -Path $sourceDir -Filter "*copy*.txt" | Sort-Object Name -Descending

Write-Host "Found $($files.Count) files to process."

foreach ($file in $files) {
    Write-Host "Merging: $($file.Name)"
    
    # Add header
    Add-Content -Path $outputFile -Value "--- Start of $($file.Name) ---" -Encoding UTF8
    
    # Add content
    Get-Content -Path $file.FullName -Encoding UTF8 | Add-Content -Path $outputFile -Encoding UTF8
    
    # Add footer
    Add-Content -Path $outputFile -Value "`n--- End of $($file.Name) ---`n" -Encoding UTF8
}

Write-Host "Done."
