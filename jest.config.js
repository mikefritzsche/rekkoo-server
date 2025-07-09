module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js?(x)', '**/?(*.)+(spec|test).js?(x)'],
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^pg$': '<rootDir>/__mocks__/pg.js',
  },
}; 