/** BTCPay LNURLVerify ChainDirectory.cs:12-29 at 9b41b56: the chains its checkout can name. */
export const BTCPAY_CHAINS = [
  "eip155:1", "eip155:11155111", "eip155:42161", "eip155:421614", "eip155:8453", "eip155:84532", "eip155:10",
  "eip155:11155420", "eip155:137", "eip155:80002", "eip155:56", "eip155:43114",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  "tron:0x2b6653dc", "tron:0xcd8690dc", "tron:0x94a9059e",
];

/** CaipAsset.cs's shape, which both consumers parse CAIP-19 ids with. */
export const CAIP19 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8}):([-.%a-zA-Z0-9]{1,128})$/;
