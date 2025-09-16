#!/bin/bash
# Build packages for different Linux distributions

set -e

VERSION="1.0.0"
PKG_NAME="miu-client"

echo "Building MIU Linux Client packages..."

# Create source distribution
echo "Creating source distribution..."
python3 setup.py sdist

# Build Debian/Ubuntu package
if command -v dpkg-buildpackage &> /dev/null; then
    echo "Building Debian package..."
    mkdir -p build/debian
    cp -r debian build/
    cp *.py build/
    cp setup.py build/
    cp requirements.txt build/
    cd build
    dpkg-buildpackage -us -uc -b
    cd ..
    echo "Debian package built in build/"
fi

# Build RPM package
if command -v rpmbuild &> /dev/null; then
    echo "Building RPM package..."
    mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
    cp dist/${PKG_NAME}-${VERSION}.tar.gz ~/rpmbuild/SOURCES/
    cp ${PKG_NAME}.spec ~/rpmbuild/SPECS/
    rpmbuild -ba ~/rpmbuild/SPECS/${PKG_NAME}.spec
    echo "RPM package built in ~/rpmbuild/RPMS/"
fi

# Build Arch package
if command -v makepkg &> /dev/null; then
    echo "Building Arch package..."
    mkdir -p build/arch
    cp PKGBUILD build/arch/
    cp dist/${PKG_NAME}-${VERSION}.tar.gz build/arch/
    cd build/arch
    makepkg -s
    cd ../..
    echo "Arch package built in build/arch/"
fi

# Build universal wheel
echo "Building Python wheel..."
python3 setup.py bdist_wheel

# Create AppImage (if appimagetool is available)
if command -v appimagetool &> /dev/null; then
    echo "Building AppImage..."
    mkdir -p build/AppDir/usr/bin
    mkdir -p build/AppDir/usr/share/applications
    mkdir -p build/AppDir/usr/share/icons/hicolor/64x64/apps

    # Copy application
    cp miu_client.py build/AppDir/usr/bin/miu-client
    chmod +x build/AppDir/usr/bin/miu-client

    # Create desktop file
    cat > build/AppDir/usr/share/applications/miu-client.desktop << EOF
[Desktop Entry]
Type=Application
Name=MIU Client
Comment=Lightweight music streaming client
Exec=miu-client
Icon=miu-client
Categories=AudioVideo;Audio;Player;
EOF

    # Create a simple icon (you can replace with actual icon)
    convert -size 64x64 xc:blue build/AppDir/usr/share/icons/hicolor/64x64/apps/miu-client.png 2>/dev/null || echo "Note: ImageMagick not available, skipping icon"

    # Create AppRun
    cat > build/AppDir/AppRun << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin/:${PATH}"
cd "${HERE}/usr/bin"
exec ./miu-client "$@"
EOF
    chmod +x build/AppDir/AppRun

    # Copy desktop file to root
    cp build/AppDir/usr/share/applications/miu-client.desktop build/AppDir/

    # Build AppImage
    cd build
    appimagetool AppDir ${PKG_NAME}-${VERSION}-x86_64.AppImage
    cd ..
    echo "AppImage built in build/"
fi

echo "Package building complete!"
echo "Available packages:"
ls -la build/ dist/ 2>/dev/null || true