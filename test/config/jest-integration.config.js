/**
 * Jest Configuration for Integration Tests
 * 
 * This configures Jest specifically for our integration test suite,
 * with longer timeouts and environment-specific settings.
 */

module.exports = {
  // Test environment
  testEnvironment: 'node',
  
  // Root directory for tests (project root)
  rootDir: '../../',
  
  // Only run integration tests
  testMatch: [
    '<rootDir>/test/integration/**/*.test.ts'
  ],
  
  // Ignore unit tests and other directories
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/test/unit/',
    '<rootDir>/dist/'
  ],
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/test/config/jest-setup.ts'
  ],
  
  // Timeout for integration tests (longer than unit tests)
  testTimeout: 60000, // 60 seconds
  
  // Run tests serially to avoid AWS rate limits and resource conflicts
  maxConcurrency: 1,
  maxWorkers: 1,
  
  // Coverage settings for integration tests
  collectCoverageFrom: [
    '<rootDir>/lambda/**/*.ts',
    '<rootDir>/lib/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/test/**'
  ],
  
  coverageThreshold: {
    global: {
      statements: 60, // Lower threshold for integration tests
      branches: 50,
      functions: 60,
      lines: 60
    }
  },
  
  // Reporter configuration
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: './test-results/integration',
        outputName: 'integration-test-results.xml',
        suiteName: 'Integration Tests'
      }
    ],
    [
      'jest-html-reporters',
      {
        publicPath: './test-results/integration',
        filename: 'integration-test-report.html',
        expand: true,
        hideIcon: false,
        pageTitle: 'Game Auth Service - Integration Test Report'
      }
    ]
  ],
  
  // Module name mapping for our test utilities
  moduleNameMapper: {
    '^@test/(.*)$': '<rootDir>/$1',
    '^@helpers/(.*)$': '<rootDir>/helpers/$1',
    '^@config/(.*)$': '<rootDir>/config/$1'
  },
  
  // Global variables available in tests
  globals: {
    // Set test environment
    'process.env.NODE_ENV': 'test',
    'process.env.TEST_ENV': process.env.TEST_ENV || 'test'
  },
  
  // Transform configuration
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/test/tsconfig.json'
      }
    ]
  },
  
  // Module file extensions
  moduleFileExtensions: ['ts', 'js', 'json'],
  
  // Verbose output for debugging
  verbose: true,
  
  // Handle AWS SDK v3 ESM modules
  extensionsToTreatAsEsm: ['.ts'],
  
  // Transform node_modules for AWS SDK and node-fetch
  transformIgnorePatterns: [
    'node_modules/(?!(@aws-sdk|node-fetch|data-uri-to-buffer|fetch-blob|formdata-polyfill)/)'
  ],
  
  // Test results directory
  testResultsProcessor: undefined, // Let reporters handle this
  
  // Cache configuration
  cacheDirectory: '<rootDir>/node_modules/.cache/jest-integration',
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Handle unhandled promise rejections (removed - not a valid Jest option)
  
  // Display names for different test suites
  displayName: {
    name: 'Integration Tests',
    color: 'blue'
  }
};