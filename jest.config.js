module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: false,
      tsconfig: {
        module: 'commonjs',
        target: 'es2020',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        moduleResolution: 'node',
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true
      }
    }]
  },
  setupFilesAfterEnv: ['<rootDir>/test/config/jest-setup.ts'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    'lambda/**/*.ts',
    '!lib/**/*.d.ts',
    '!lambda/**/index.ts',
    '!**/*.test.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 70,
      lines: 75,
      statements: 75
    }
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testTimeout: 30000,
  verbose: true,
  // Explicitly disable Babel transformation  
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$))'
  ]
};