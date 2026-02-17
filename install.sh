#!/bin/bash

# Quick setup script for Perplexity MCP Server + VSCode Extension

echo "🚀 Setting up Perplexity MCP Server..."

# Install MCP Server dependencies
echo "📦 Installing MCP Server dependencies..."
cd "$(dirname "$0")/mcp-server"
npm install

# Build MCP Server
echo "🔨 Building MCP Server..."
npm run build

# Install VSCode Extension dependencies
echo "📦 Installing VSCode Extension dependencies..."
cd ../vscode-extension
npm install

# Build VSCode Extension
echo "🔨 Building VSCode Extension..."
npm run compile

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Start the MCP Server:"
echo "   cd mcp-server && npm run dev"
echo ""
echo "2. Install VSCode Extension:"
echo "   - Open VSCode"
echo "   - Open the 'vscode-extension' folder"
echo "   - Press F5 to run in debug mode"
echo "   - Or run 'vsce package' to create .vsix file"
echo ""
echo "3. The Perplexity icon will appear in the Activity Bar"
