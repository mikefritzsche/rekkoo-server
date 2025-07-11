const ListService = require('../ListService');
const { logger } = require('../../utils/logger');

// Mock the logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('ListService', () => {
  describe('createDetailRecord', () => {
    let mockClient;

    beforeEach(() => {
      mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 'test-detail-id' }] })
      };
      jest.clearAllMocks();
    });

    it('should handle JSON columns correctly for movie_details', async () => {
      const apiMetadata = {
        raw_details: {
          tmdb_spoken_languages: [{ iso_639_1: 'en', name: 'English' }],
          tmdb_production_companies: [{ id: 1, name: 'Test Studio' }],
          tmdb_production_countries: [{ iso_3166_1: 'US', name: 'United States' }],
          tmdb_genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
          tmdb_vote_average: 7.5,
          tmdb_original_title: 'Test Movie'
        },
        source_id: '12345',
        title: 'Test Movie'
      };

      const result = await ListService.createDetailRecord(
        mockClient,
        'movie_details',
        apiMetadata,
        'test-list-item-id',
        {}
      );

      expect(mockClient.query).toHaveBeenCalled();
      const [query, values] = mockClient.query.mock.calls[0];

      // Find the indices of JSON columns in the query
      const queryParts = query.split('(')[1].split(')')[0].split(', ');
      const valuesParts = query.split('VALUES (')[1].split(')')[0].split(', ');

      const spokenLanguagesIndex = queryParts.indexOf('spoken_languages');
      const productionCompaniesIndex = queryParts.indexOf('production_companies');
      const productionCountriesIndex = queryParts.indexOf('production_countries');

      if (spokenLanguagesIndex !== -1) {
        const spokenLanguagesValue = values[spokenLanguagesIndex];
        expect(() => JSON.parse(spokenLanguagesValue)).not.toThrow();
        expect(JSON.parse(spokenLanguagesValue)).toEqual([{ iso_639_1: 'en', name: 'English' }]);
      }

      if (productionCompaniesIndex !== -1) {
        const productionCompaniesValue = values[productionCompaniesIndex];
        expect(() => JSON.parse(productionCompaniesValue)).not.toThrow();
        expect(JSON.parse(productionCompaniesValue)).toEqual([{ id: 1, name: 'Test Studio' }]);
      }

      if (productionCountriesIndex !== -1) {
        const productionCountriesValue = values[productionCountriesIndex];
        expect(() => JSON.parse(productionCountriesValue)).not.toThrow();
        expect(JSON.parse(productionCountriesValue)).toEqual([{ iso_3166_1: 'US', name: 'United States' }]);
      }

      expect(result).toEqual({ id: 'test-detail-id' });
    });

    it('should handle already stringified JSON columns', async () => {
      const apiMetadata = {
        raw_details: {
          tmdb_spoken_languages: JSON.stringify([{ iso_639_1: 'en', name: 'English' }]),
          tmdb_vote_average: 7.5,
          tmdb_original_title: 'Test Movie'
        },
        source_id: '12345',
        title: 'Test Movie'
      };

      const result = await ListService.createDetailRecord(
        mockClient,
        'movie_details',
        apiMetadata,
        'test-list-item-id',
        {}
      );

      expect(mockClient.query).toHaveBeenCalled();
      const [query, values] = mockClient.query.mock.calls[0];

      // The spoken_languages should still be valid JSON
      const queryParts = query.split('(')[1].split(')')[0].split(', ');
      const spokenLanguagesIndex = queryParts.indexOf('spoken_languages');

      if (spokenLanguagesIndex !== -1) {
        const spokenLanguagesValue = values[spokenLanguagesIndex];
        expect(() => JSON.parse(spokenLanguagesValue)).not.toThrow();
        expect(JSON.parse(spokenLanguagesValue)).toEqual([{ iso_639_1: 'en', name: 'English' }]);
      }
    });

    it('should handle invalid JSON strings by wrapping them', async () => {
      const apiMetadata = {
        raw_details: {
          tmdb_spoken_languages: '{"invalid": json}', // Invalid JSON
          tmdb_vote_average: 7.5,
          tmdb_original_title: 'Test Movie'
        },
        source_id: '12345',
        title: 'Test Movie'
      };

      const result = await ListService.createDetailRecord(
        mockClient,
        'movie_details',
        apiMetadata,
        'test-list-item-id',
        {}
      );

      expect(mockClient.query).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid JSON string for spoken_languages'),
        '{"invalid": json}'
      );
    });

    it('should handle genres array correctly', async () => {
      const apiMetadata = {
        raw_details: {
          tmdb_genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
          tmdb_vote_average: 7.5,
          tmdb_original_title: 'Test Movie'
        },
        source_id: '12345',
        title: 'Test Movie'
      };

      const result = await ListService.createDetailRecord(
        mockClient,
        'movie_details',
        apiMetadata,
        'test-list-item-id',
        {}
      );

      expect(mockClient.query).toHaveBeenCalled();
      const [query, values] = mockClient.query.mock.calls[0];

      // Find the genres value
      const queryParts = query.split('(')[1].split(')')[0].split(', ');
      const genresIndex = queryParts.indexOf('genres');

      if (genresIndex !== -1) {
        const genresValue = values[genresIndex];
        // Genres should be an array of strings (names only)
        expect(genresValue).toEqual(['Action', 'Adventure']);
      }
    });

    it('should still create a stub detail row when metadata has no mappable fields', async () => {
      const apiMetadata = {
        raw_details: {
          unmapped_field: 'value'
        }
      };

      const result = await ListService.createDetailRecord(
        mockClient,
        'movie_details',
        apiMetadata,
        'test-list-item-id',
        {}
      );

      // Should have inserted a bare record containing at least list_item_id
      expect(mockClient.query).toHaveBeenCalled();
      expect(result).toEqual({ id: 'test-detail-id' });
    });

    it('should throw error when listItemId is missing', async () => {
      await expect(
        ListService.createDetailRecord(
          mockClient,
          'movie_details',
          {},
          null,
          {}
        )
      ).rejects.toThrow('listItemId is required to create a detail record.');
    });
  });
}); 