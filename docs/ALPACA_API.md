# Alpaca Markets API Documentation

## Stock Quotes Latest Endpoint

**Endpoint:** `https://data.alpaca.markets/v2/stocks/quotes/latest`

### Response Object Properties

The response contains a `quotes` object with stock symbols as keys. Each quote object contains the following properties:

- **ap** (Ask Price): The lowest price a seller is willing to accept
- **as** (Ask Size): Number of shares available at the ask price
- **ax** (Ask Exchange): Exchange code where the ask quote originated (V = IEX)
- **bp** (Bid Price): The highest price a buyer is willing to pay
- **bs** (Bid Size): Number of shares available at the bid price
- **bx** (Bid Exchange): Exchange code where the bid quote originated (V = IEX)
- **c** (Conditions): Array of condition codes (R = Regular market hours)
- **t** (Timestamp): When the quote was generated (RFC3339 format)
- **z** (Tape): Which tape/feed the quote came from (C = Nasdaq-listed stocks)

### Example Response

```json
{
    "quotes": {
        "AAPL": {
            "ap": 234.5,
            "as": 1,
            "ax": "V",
            "bp": 233.9,
            "bs": 1,
            "bx": "V",
            "c": ["R"],
            "t": "2025-09-12T19:59:59.682646543Z",
            "z": "C"
        },
        "MSFT": {
            "ap": 535,
            "as": 1,
            "ax": "V",
            "bp": 500,
            "bs": 2,
            "bx": "V",
            "c": ["R"],
            "t": "2025-09-12T19:59:53.892326006Z",
            "z": "C"
        },
        "TSLA": {
            "ap": 396.5,
            "as": 1,
            "ax": "V",
            "bp": 390,
            "bs": 1,
            "bx": "V",
            "c": ["R"],
            "t": "2025-09-12T19:59:59.990118229Z",
            "z": "C"
        }
    }
}
```

### Notes

The bid/ask spread (difference between bp and ap) indicates the stock's liquidity - smaller spreads generally mean more liquid stocks.