#!/bin/bash

# Create a portable Windows executable by concatenating files
# This creates a self-extracting executable that works on Windows

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXE_PATH="$SCRIPT_DIR/target/x86_64-pc-windows-gnu/release/miu.exe"
DLL_PATH="$SCRIPT_DIR/target/x86_64-pc-windows-gnu/release/WebView2Loader.dll"
OUTPUT_PATH="$SCRIPT_DIR/target/x86_64-pc-windows-gnu/release/miu-portable-single.exe"

if [ ! -f "$EXE_PATH" ]; then
    echo "Error: $EXE_PATH not found"
    exit 1
fi

if [ ! -f "$DLL_PATH" ]; then
    echo "Warning: $DLL_PATH not found - creating executable without bundled WebView2"
    echo "Note: WebView2 will be downloaded automatically when the application runs"
    DLL_PATH=""
fi

echo "Creating single-file portable executable..."

# Create a temporary directory for our work
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Create the extractor stub (a small executable that extracts and runs)
cat > extractor.c << 'EOF'
#include <windows.h>
#include <stdio.h>

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    HRSRC hRes;
    HGLOBAL hData;
    DWORD size;
    void *data;
    HANDLE hFile;
    DWORD written;
    char tempPath[MAX_PATH];
    char exePath[MAX_PATH];
    char dllPath[MAX_PATH];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;

    // Get temp directory
    GetTempPathA(MAX_PATH, tempPath);

    // Create filenames
    wsprintfA(exePath, "%s\\miu_temp_%d.exe", tempPath, GetCurrentProcessId());
    wsprintfA(dllPath, "%s\\WebView2Loader.dll", tempPath);

    // Extract main executable (resource ID 101)
    hRes = FindResourceA(NULL, MAKEINTRESOURCEA(101), RT_RCDATA);
    if (!hRes) return 1;

    hData = LoadResource(NULL, hRes);
    if (!hData) return 1;

    size = SizeofResource(NULL, hRes);
    data = LockResource(hData);

    hFile = CreateFileA(exePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile != INVALID_HANDLE_VALUE) {
        WriteFile(hFile, data, size, &written, NULL);
        CloseHandle(hFile);
    }

    // Extract DLL (resource ID 102) - optional, only if bundled
    hRes = FindResourceA(NULL, MAKEINTRESOURCEA(102), RT_RCDATA);
    if (hRes) {
        hData = LoadResource(NULL, hRes);
        if (hData) {
            size = SizeofResource(NULL, hRes);
            data = LockResource(hData);

            hFile = CreateFileA(dllPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hFile != INVALID_HANDLE_VALUE) {
                WriteFile(hFile, data, size, &written, NULL);
                CloseHandle(hFile);
            }
        }
    }
    // Note: If DLL resource doesn't exist, the application will download it automatically

    // Run the extracted executable silently
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    if (CreateProcessA(exePath, NULL, NULL, NULL, FALSE, 0, NULL, tempPath, (STARTUPINFOA*)&si, &pi)) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

    // Cleanup
    DeleteFileA(exePath);
    // Only delete DLL if it was extracted
    if (GetFileAttributesA(dllPath) != INVALID_FILE_ATTRIBUTES) {
        DeleteFileA(dllPath);
    }

    return 0;
}
EOF

# Copy icon to temp directory for resource compilation
cp "$SCRIPT_DIR/icons/tray-icon.ico" ./app.ico

# Create resource file with icon
cat > resources.rc << EOF
#include <windows.h>
1 ICON "app.ico"
101 RCDATA "$EXE_PATH"
EOF

# Only add DLL resource if DLL exists
if [ -n "$DLL_PATH" ] && [ -f "$DLL_PATH" ]; then
    echo "102 RCDATA \"$DLL_PATH\"" >> resources.rc
    echo "WebView2Loader.dll will be bundled in portable executable"
else
    echo "WebView2Loader.dll will not be bundled - will be downloaded on demand"
fi

echo "Compiling with mingw-w64..."

# Try to compile with mingw-w64 cross compiler
if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "Using x86_64-w64-mingw32-gcc..."
    x86_64-w64-mingw32-windres resources.rc -o resources.o
    x86_64-w64-mingw32-gcc -o "$OUTPUT_PATH" extractor.c resources.o -static -s -mwindows
    echo "Portable executable created: $OUTPUT_PATH"
    echo "Size: $(ls -lh "$OUTPUT_PATH" | awk '{print $5}')"
elif command -v wine >/dev/null 2>&1; then
    echo "Mingw not available, trying alternative approach..."
    # Alternative: just use UPX compression on the main exe
    if command -v upx >/dev/null 2>&1; then
        echo "Using UPX compression..."
        cp "$EXE_PATH" "$OUTPUT_PATH"
        upx --best "$OUTPUT_PATH" 2>/dev/null || echo "UPX compression failed, using uncompressed"
    else
        echo "No compression available, copying main executable..."
        cp "$EXE_PATH" "$OUTPUT_PATH"
    fi
else
    echo "No cross-compilation tools available"
    exit 1
fi

# Cleanup
cd - >/dev/null
rm -rf "$TEMP_DIR"

if [ -f "$OUTPUT_PATH" ]; then
    echo "✅ Created: $OUTPUT_PATH"
    ls -lh "$OUTPUT_PATH"
else
    echo "❌ Failed to create portable executable"
    exit 1
fi