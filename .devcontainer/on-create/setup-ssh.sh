#!/usr/bin/env bash
set -e

echo "🔐 Setting up SSH server..."

# Generate SSH host keys if they don't exist (runs once at container creation)
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
	echo "🔑 Generating SSH host keys..."
	sudo ssh-keygen -A
	echo "✅ SSH host keys generated"
fi

# Set up authorized_keys from the host SSH mount
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

if [ -d /mnt/host-ssh ]; then
	echo "📋 Copying SSH public keys from host..."
	added=0
	for pubkey in /mnt/host-ssh/*.pub; do
		[ -f "$pubkey" ] || continue
		key_content=$(cat "$pubkey")
		if ! grep -qF "$key_content" ~/.ssh/authorized_keys 2>/dev/null; then
			echo "$key_content" >> ~/.ssh/authorized_keys
			echo "  Added: $(basename "$pubkey")"
			((added++)) || true
		fi
	done
	if [ "$added" -eq 0 ]; then
		echo "⚠️  No new public keys found in /mnt/host-ssh (*.pub)"
	else
		echo "✅ Added $added public key(s) to authorized_keys"
	fi
else
	echo "⚠️  Host SSH directory not mounted at /mnt/host-ssh"
	echo "   Add your public key manually: echo '<pubkey>' >> ~/.ssh/authorized_keys"
fi

echo "✅ SSH setup complete"
echo "💡 Connect with: ssh -p 2222 vscode@localhost"
echo "   Or add to ~/.ssh/config:"
echo "     Host devcontainer"
echo "       HostName localhost"
echo "       Port 2222"
echo "       User vscode"
