module.exports = {
  displayName: 'Integration Tests',
  testEnvironment: 'node',
  rootDir: '../../',
  testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['<rootDir>/test/config/jest-setup.ts'],
  testTimeout: 120000, // 2 minutes for integration tests
  collectCoverageFrom: [
    'lambda/**/*.ts',
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lambda/**/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 65,
      lines: 70,
      statements: 70
    }
  },
  reporters: [
    'default',
    ['jest-html-reporters', {
      publicPath: './test-results/integration',
      filename: 'integration-test-report.html',
      expand: true
    }],
    ['jest-junit', {
      outputDirectory: './test-results/integration',
      outputName: 'integration-test-results.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}'
    }]
  ]
};