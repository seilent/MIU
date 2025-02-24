const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

interface EnvConfig {
  [key: string]: string | undefined;
}

function loadEnvFile(filePath: string): EnvConfig {
  try {
    const envContent = fs.readFileSync(filePath, 'utf8');
    return dotenv.parse(envContent);
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error);
    return {};
  }
}

function resolveEnvVars(env: EnvConfig, maxDepth = 5): EnvConfig {
  const resolved: EnvConfig = {};
  let depth = 0;
  
  const resolveValue = (value: string): string => {
    if (depth >= maxDepth) return value;
    
    return value.replace(/\${([^}]+)}/g, (match, varName) => {
      if (!env[varName]) return match;
      depth++;
      const resolvedValue = resolveValue(env[varName]!);
      depth--;
      return resolvedValue;
    });
  };
  
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    depth = 0;
    resolved[key] = resolveValue(value);
  }
  
  return resolved;
}

function generateFrontendContent(baseEnv: EnvConfig, envType: 'development' | 'production'): string {
  const resolvedEnv = resolveEnvVars(baseEnv);
  
  // Create environment-specific overrides
  const envOverrides: EnvConfig = {
    NEXT_PUBLIC_URL: resolvedEnv.URL,
    NEXT_PUBLIC_API_URL: resolvedEnv.API_URL,
    NEXT_PUBLIC_DISCORD_CLIENT_ID: resolvedEnv.DISCORD_CLIENT_ID,
    NEXT_PUBLIC_DISCORD_REDIRECT_URI: `${resolvedEnv.URL}/auth/callback`,
    NODE_ENV: envType
  };

  // Combine with base environment
  const combinedEnv = { ...resolvedEnv, ...envOverrides };
  
  // Filter frontend variables
  const frontendVars = Object.entries(combinedEnv)
    .filter(([key]) => 
      key.startsWith('NEXT_PUBLIC_') || 
      ['NODE_ENV'].includes(key)
    )
    .sort(([a], [b]) => a.localeCompare(b));

  // Generate content with comments
  const content = [
    `# Generated environment configuration for ${envType} environment`,
    `# Generated at ${new Date().toISOString()}`,
    '',
    ...frontendVars.map(([key, value]) => `${key}=${value}`)
  ];

  return content.join('\n');
}

function generateBackendContent(baseEnv: EnvConfig, envType: 'development' | 'production'): string {
  const resolvedEnv = resolveEnvVars(baseEnv);

  // Create environment-specific overrides
  const envOverrides: EnvConfig = {
    NODE_ENV: envType,
    API_URL: resolvedEnv.API_URL,
    FRONTEND_URL: resolvedEnv.URL,
    CORS_ORIGIN: resolvedEnv.URL
  };

  // Combine with base environment and resolve variables
  const combinedEnv = resolveEnvVars({ ...resolvedEnv, ...envOverrides });

  // Generate content with comments
  const content = [
    `# Generated environment configuration for ${envType} environment`,
    `# Generated at ${new Date().toISOString()}`,
    '',
    ...Object.entries(combinedEnv)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
  ];

  return content.join('\n');
}

function writeEnvFile(filePath: string, content: string) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
    console.log(`Successfully wrote ${filePath}`);
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
  }
}

function updateEnvFiles() {
  // Load base environment
  const baseEnv = loadEnvFile(path.resolve(process.cwd(), '.env'));
  
  // Generate frontend environment files
  const frontendEnvironments: Array<'development' | 'production'> = ['development', 'production'];
  frontendEnvironments.forEach(env => {
    const frontendContent = generateFrontendContent(baseEnv, env);
    const frontendPath = path.resolve(process.cwd(), 'frontend', `.env.${env}`);
    writeEnvFile(frontendPath, frontendContent);
  });

  // Generate development environment files
  const devContent = generateBackendContent(baseEnv, 'development');
  writeEnvFile(path.resolve(process.cwd(), '.env.development'), devContent);
  writeEnvFile(path.resolve(process.cwd(), 'backend', '.env.development'), devContent);

  // Generate production environment files
  const prodContent = generateBackendContent(baseEnv, 'production');
  writeEnvFile(path.resolve(process.cwd(), '.env.production'), prodContent);
  writeEnvFile(path.resolve(process.cwd(), 'backend', '.env.production'), prodContent);

  console.log('Environment files updated successfully');
}

// Run the update
updateEnvFiles(); 