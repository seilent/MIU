const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Run a find command to get all TypeScript files
const files = execSync('find src -type f -name "*.ts"')
  .toString()
  .trim()
  .split('\n');

console.log(`Found ${files.length} TypeScript files to process`);

let totalChanges = 0;

// Process each file
files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  
  // This regex matches relative imports that don't already have .js extensions
  // It captures:
  // 1. The part before the from statement
  // 2. The opening quote (single or double)
  // 3. The relative path starting with ./ or ../
  // 4. The closing quote
  const regex = /(import(?:(?:[\s\S]*?)from)?\s+(?!['"](?:https?:|@|[a-zA-Z]|[^.\/])['"])['"])(\.\.?\/[^'"]*)(['"])/g;
  
  // Replace relative imports without extensions to include .js
  const newContent = content.replace(regex, (match, beforePath, path, endQuote) => {
    // Only add .js if it doesn't already have an extension
    if (!/\.[a-zA-Z0-9]+$/.test(path)) {
      return `${beforePath}${path}.js${endQuote}`;
    }
    return match;
  });
  
  // If content changed, write back to file
  if (content !== newContent) {
    console.log(`Fixing imports in ${file}`);
    fs.writeFileSync(file, newContent, 'utf8');
    totalChanges++;
  }
});

console.log(`Fixed imports in ${totalChanges} files`);
console.log('Now run "npm run build" to recompile the project'); 