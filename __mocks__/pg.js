const pg = jest.createMockFromModule('pg');

class MockClient {
  async connect() {}
  async query(query) {
    if (query === 'SELECT NOW()') {
      return { rows: [{ now: new Date().toISOString() }] };
    }
    return { rows: [] };
  }
  async release() {}
  escapeIdentifier(str) {
    return `"${str}"`;
  }
}

pg.Pool = class MockPool {
  async connect() {
    return new MockClient();
  }
  async query() {
    return { rows: [] };
  }
  async end() {}
  on() {}
};

module.exports = pg; 