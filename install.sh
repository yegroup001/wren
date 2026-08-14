#!/usr/bin/env bash
set -euo pipefail

APP=wren
REPO="yegroup001/wren"
INSTALL_DIR="${WREN_INSTALL_DIR:-$HOME/.wren/bin}"
# Overridable base for downloads (e.g. a mirror); defaults to GitHub Releases.
BASE_URL="${WREN_BASE_URL:-https://github.com/${REPO}/releases}"

MUTED='\033[0;2m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
    cat <<EOF
Wren Installer

Usage: install.sh [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g., 0.1.0)
    -b, --binary <path>     Install from a local binary instead of downloading
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc)

Examples:
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --version 0.1.0
EOF
}

requested_version=""
no_modify_path=false
binary_path=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                echo -e "${RED}Error: --version requires a version argument${NC}" >&2
                exit 1
            fi
            ;;
        -b|--binary)
            if [[ -n "${2:-}" ]]; then
                binary_path="$2"
                shift 2
            else
                echo -e "${RED}Error: --binary requires a path argument${NC}" >&2
                exit 1
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        *)
            echo -e "${RED}Error: Unknown option '$1'${NC}" >&2
            usage
            exit 1
            ;;
    esac
done

error() {
    echo -e "${RED}Error: $*${NC}" >&2
    exit 1
}

detect_platform() {
    local os arch
    os=$(uname -s | tr '[:upper:]' '[:lower:]')

    case "$os" in
        linux)
            arch=$(uname -m)
            case "$arch" in
                x86_64|amd64) echo -n "linux-x64" ;;
                aarch64|arm64) echo -n "linux-arm64" ;;
                *) error "unsupported architecture: $arch" ;;
            esac
            if [ -f /etc/alpine-release ]; then
                echo -n "-musl"
            fi
            echo
            ;;
        darwin)
            arch=$(uname -m)
            case "$arch" in
                x86_64) echo "darwin-x64" ;;
                arm64) echo "darwin-arm64" ;;
                *) error "unsupported architecture: $arch" ;;
            esac
            ;;
        mingw*|msys*|cygwin*)
            echo "win32-x64"
            ;;
        *)
            error "unsupported OS: $os"
            ;;
    esac
}

mkdir -p "$INSTALL_DIR"

if [ -n "$binary_path" ]; then
    if [ ! -f "$binary_path" ]; then
        error "binary not found at ${binary_path}"
    fi
    specific_version="local"
    platform="local"
    tmpdir=""
else
    platform=$(detect_platform)
    echo -e "${MUTED}Detected platform: ${platform}${NC}"

    if [ -z "$requested_version" ]; then
        base_url="${BASE_URL}/latest/download"
        specific_version="latest"
    else
        case "$requested_version" in
            v*) tag="$requested_version" ;;
            *) tag="v$requested_version" ;;
        esac
        base_url="${BASE_URL}/download/${tag}"
        specific_version="$requested_version"
    fi

    archive="$APP-$platform.tar.gz"
    url="$base_url/$archive"

    echo -e "${MUTED}Downloading ${url}${NC}"
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$tmpdir/$archive"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$url" -O "$tmpdir/$archive"
    else
        error "neither curl nor wget is available"
    fi

    tar -xzf "$tmpdir/$archive" -C "$tmpdir"
    if [ "$platform" = "win32-x64" ]; then
        binary_path="$tmpdir/$APP.exe"
    else
        binary_path="$tmpdir/$APP"
    fi
    if [ ! -f "$binary_path" ]; then
        error "archive did not contain a $APP binary"
    fi
fi

chmod +x "$binary_path"
if [ "$platform" = "win32-x64" ]; then
    install -m 0755 "$binary_path" "$INSTALL_DIR/$APP.exe"
else
    install -m 0755 "$binary_path" "$INSTALL_DIR/$APP"
fi
rm -rf "$tmpdir"

if ! "$INSTALL_DIR/$APP" --version >/dev/null 2>&1; then
    error "installed binary failed to run"
fi

echo -e "${GREEN}Installed $APP ($specific_version) to $INSTALL_DIR/$APP${NC}"
echo -e "${MUTED}Version: $("$INSTALL_DIR/$APP" --version)${NC}"

if [ "$no_modify_path" = true ] || echo ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
    if [ "$no_modify_path" = true ]; then
        echo -e "${MUTED}PATH not modified (--no-modify-path). Add $INSTALL_DIR to your PATH manually.${NC}"
    fi
else
    case "${SHELL:-}" in
        *zsh) profile="$HOME/.zshrc" ;;
        *bash) profile="$HOME/.bashrc" ;;
        *) profile="$HOME/.profile" ;;
    esac
    {
        echo ""
        echo "# Added by the $APP installer"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\""
    } >>"$profile"
    echo -e "${MUTED}Added $INSTALL_DIR to PATH in $profile (restart your shell or run: export PATH=\"$INSTALL_DIR:\$PATH\")${NC}"
fi
