const SecretSantaService = require('../SecretSantaService');

describe('SecretSantaService exclusions', () => {
  it('respects exclusions while generating pairings', () => {
    const participants = ['user-a', 'user-b', 'user-c', 'user-d'];
    const exclusions = [{ user_id: 'user-a', excluded_user_id: 'user-b' }];

    const pairings = SecretSantaService.generatePairings(participants, exclusions);

    const recipients = new Set(pairings.map((pair) => pair.recipient));
    expect(recipients.size).toBe(participants.length);
    pairings.forEach((pair) => {
      expect(pair.giver).not.toBe(pair.recipient);
      expect(
        ['user-a__user-b', 'user-b__user-a'].includes(`${pair.giver}__${pair.recipient}`)
      ).toBe(false);
    });
  });

  it('throws a clear error when exclusions make a draw impossible', () => {
    const participants = ['one', 'two', 'three'];
    const exclusions = [
      { user_id: 'one', excluded_user_id: 'two' },
      { user_id: 'two', excluded_user_id: 'three' },
      { user_id: 'three', excluded_user_id: 'one' },
    ];

    expect(() => SecretSantaService.generatePairings(participants, exclusions)).toThrow(
      /Unable to create Secret Santa assignments/i
    );
  });
});
