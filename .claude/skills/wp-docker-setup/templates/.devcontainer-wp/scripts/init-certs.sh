#!/usr/bin/env sh
set -eu

cert_dir="/workspace/.devcontainer/certs"
crt="$cert_dir/localhost.crt"
key="$cert_dir/localhost.key"

if [ ! -s "$crt" ] || [ ! -s "$key" ]; then
  mkdir -p "$cert_dir"
  openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -keyout "$key" -out "$crt" \
    -subj "/C=JP/ST=Tokyo/L=Tokyo/O=Local Development/OU=Development/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
fi
