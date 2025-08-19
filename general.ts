import { config } from 'dotenv';
import {
  MsgExecuteContract,
  SecretNetworkClient,
  Wallet, 
} from 'secretjs';
import * as fs from 'fs';
import { Route } from '@shadeprotocol/shadejs';
import { BigNumber } from 'bignumber.js';
import { getRoutes } from './router.js';

function mapGQLResponseToTarget(
  poolsResponse: any, 
  tokensResponse: any
) {
  const pairs = poolsResponse.pools.map((pool: any) => {
    const token0 = tokensResponse.tokens.find((token: any) => token.id === pool.token0Id);
    const token1 = tokensResponse.tokens.find((token: any) => token.id === pool.token1Id);
    return {
      pairContractAddress: pool.contractAddress,
      pairInfo: {
        lpTokenAmount: pool.lpTokenAmount,
        lpTokenContract: {
          address: pool.lpTokenId,
          codeHash: pool.codeHash,
        },
        token0Contract: { address: token0?.contractAddress, },
        token1Contract: { address: token1?.contractAddress, },
        isStable: pool.StableParams !== null,
        token0Amount: pool.token0Amount,
        token1Amount: pool.token1Amount,
        lpFee: parseFloat(pool.lpFee),
        daoFee: parseFloat(pool.daoFee),
        stableParams: pool.StableParams ? {
          priceRatio: pool.StableParams.priceRatio,
          alpha: pool.StableParams.alpha,
          gamma1: pool.StableParams.gamma1,
          gamma2: pool.StableParams.gamma2,
          minTradeSizeXForY: pool.StableParams.minTradeSize0For1,
          minTradeSizeYForX: pool.StableParams.minTradeSize1For0,
          maxPriceImpactAllowed: pool.StableParams.maxPriceImpact,
        } : null,
      },
    }
  });

  // Create tokens configuration using the tokens response
  const tokens = tokensResponse.tokens.map((token: any) => ({
    tokenContractAddress: token.contractAddress,
    decimals: token.Asset.decimals,
  }));

  return {
    pairs,
    tokens,
  };
}

type Results = {
  queryLength: number[],
  profit: number[],
  start?: number,
  lastUpdate?: number,
  lastFailure: number,
  successfulTxs: number,
  failedTxs: number,
  failedQueries: number,
  lastBlockHeight: number,
  lastCalc: number,
  tradeSize: {
    [key: string]: {
      tradeSize: number,
      price: number,
    },
  },
}

type Borrowable = {
  address: string,
  oracleKey: string,
  decimals: number,
}

config();

if(!process.env.LCD_NODE 
   || !process.env.CHAIN_ID
   || !process.env.PRIVATE_KEY
   || !process.env.WALLET_ADDRESS
   || !process.env.MONEY_MARKET_ADDRESS
   || !process.env.SHADE_MASTER_PERMIT
   || !process.env.GRAPHQL
   || !process.env.BORROWABLES
   || !process.env.ORACLE_ADDRESS
  ) {
  throw new Error('Missing env variables are required in the .env file');
}

// Alows you to easly decrypt transacitons later
const encryptionSeed = process.env.ENCRYPTION_SEED 
  ? Uint8Array.from(process.env.ENCRYPTION_SEED!.split(',').map(Number)) 
  : undefined;

const client = new SecretNetworkClient({
  url: process.env.LCD_NODE!,
  chainId: process.env.CHAIN_ID!,
  wallet: new Wallet(process.env.PRIVATE_KEY!),
  walletAddress: process.env.WALLET_ADDRESS!,
  encryptionSeed,
});

const encodeJsonToB64 = (toEncode:any) : string => Buffer.from(
  JSON.stringify(toEncode), 'utf8'
).toString('base64');

const decodeB64ToJson = (encodedData: string) => JSON.parse(
  Buffer.from(encodedData, 'base64').toString('utf8')
);

const getCentralTime = (date: Date): string => {
  return date.toLocaleString(
    'en-US', 
    {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  ).replace(
    /(\d+)\/(\d+)\/(\d+)/, 
    '$3-$1-$2'
  );
};

const logger = {
  error: (msg: string, time: Date, error?: any) => {
    console.error(`[${getCentralTime(time)} ERROR] ${msg}`, error);
  },
  info: (msg: string, time: Date) => {
    console.log(`[${getCentralTime(time)} INFO] ${msg}`);
  }
};

async function main() {
  if (!fs.existsSync(`./results.txt`)) {
    const initialState: Results = { 
      queryLength: [], 
      profit: [],
      successfulTxs: 0,
      failedTxs: 0,
      failedQueries: 0,
      lastFailure: 0,
      lastBlockHeight: 0,
      lastCalc: 0,
      tradeSize: {},
    };
    fs.writeFileSync(`./results.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./results.txt`, 'utf-8');
  const results: Results = JSON.parse(resultsUnparsed);

  const now = new Date();

  const blockResponse = await client.query.tendermint.getLatestBlock({})
  const blockHeight = blockResponse?.block?.header?.height;
  if(blockHeight !== undefined && Number(blockHeight) !== results.lastBlockHeight) {
    results.lastBlockHeight = Number(blockHeight);
  } else {
    if(now.getTime() - results.lastCalc > 1_800_000) {
      const mmPositionQuery = await client.query.compute.queryContract({
        contract_address: process.env.MONEY_MARKET_ADDRESS!,
        code_hash: process.env.MONEY_MARKET_CODE_HASH,
        query: { 
          user_position: { 
            authentication: { 
              permit: JSON.parse(
                process.env.SHADE_MASTER_PERMIT!
              ) 
            } 
          } 
        }
      }) as any;
      const maxBorrowValue = mmPositionQuery.max_borrow_value;
      const borrowables: Borrowable[] = JSON.parse(process.env.BORROWABLES!);
      const prices: any[] = await client.query.compute.queryContract({
        contract_address: process.env.ORACLE_ADDRESS!,
        code_hash: process.env.ORACLE_CODE_HASH,
        query: { get_prices:{ keys: borrowables.map((b) => b.oracleKey) } },
      });
      prices.forEach((data: {key:string;data:{rate:string}}) => {
        const tradeSize = (maxBorrowValue * 0.95) / (Number(data.data.rate) / 10**18);
        const borrowable = borrowables.find((b) => b.oracleKey === data.key);
        if(borrowable?.address !== undefined) {
          results.tradeSize[borrowable?.address] = {
            tradeSize: Number(
              (tradeSize * 10**borrowable.decimals).toFixed(0)
            ),
            price: (Number(data.data.rate) / 10**18)
          };
        }
        
      });
      results.lastCalc = now.getTime();
      fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    }
    return;
  }

  if (results.start === undefined ||  now.getTime() - (results.lastUpdate ?? 0) > 3_600_000 * 2) {
    if(results.start === undefined) {
      results.start = now.getTime();
    }
    if(results.queryLength === undefined) {
      results.queryLength = [];
    }
    const queryLength = results.queryLength.reduce(
      (acc, curr) => acc + curr, 
      0
    ) / results.queryLength.length;
    const aveProfit = results.profit.reduce(
      (acc, curr) => acc + curr, 
      0
    ) / results.profit.length;
    results.lastUpdate = now.getTime();
    logger.info(
      `Bot running for ${Math.floor((now.getTime() - results.start) / 3_600_000)} hours` +
      `  Successful: ${results.successfulTxs}` +
      `  Failed: ${results.failedTxs}` +
      `  Queries Failed: ${results.failedQueries} ` +
      `  Average Query Length: ${queryLength.toFixed(3)}` +
      `  Profit: ${aveProfit.toFixed(5)}`,
      now
    );
    results.failedQueries = 0; // reset query errors after logging
  }

  if( now.getTime() - results.lastFailure < 1_800_000) {
    // Don't run if the last failure was less than 1 half hour ago
    return;
  }

  let query = `
    query Pools {
      pools(query: {}) {
        id
        contractAddress
        codeHash
        lpTokenId
        lpTokenAmount
        token0Id
        token0Amount
        token1Id
        token1Amount
        daoFee
        lpFee
        poolApr
        stakingContractAddress
        stakingContractCodeHash
        stakedLpTokenAmount
        flags
        isEnabled
        liquidityUsd
        volumeUsd
        volumeChangePercent
        StableParams {
          id
          priceRatio
          alpha
          gamma1
          gamma2
          minTradeSize0For1
          minTradeSize1For0
          maxPriceImpact
        }
        PoolToken {
          rewardPerSecond
          expirationDate
          tokenId
        } 
      }
    }
  `;
  const poolsRaw = await fetch(process.env.GRAPHQL!, {
    method: "POST",
    headers: { "Content-Type": "application/json", },
    body: JSON.stringify({ query, })
  });
  const poolsBody = await poolsRaw.json();
  if (poolsBody.errors || poolsBody.data == undefined) {
    results.failedQueries += 1;
    fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
    return;
  }
  query = `
    query Tokens {
      tokens(query: {
        where: {
          flags: {
            has: SNIP20
          }
        }
      }) {
        id
        contractAddress
        symbol
        Asset {
          decimals
        }
        PriceToken{
          priceId
        }
      }
    }
  `;

  const gqlTokenResp = await fetch(process.env.GRAPHQL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", },
      body: JSON.stringify({ query, })
  });
  const tokenBody = await gqlTokenResp.json();
  if (tokenBody.errors || tokenBody.data == undefined) {
    results.failedQueries += 1;
    fs.writeFileSync(`./results.txt`, JSON.stringify(results, null, 2));
    return;
  }
  const filteredPools = poolsBody.data.pools.filter((pool: any) => pool.liquidityUsd > 5_000);
  const formmattedPoolsAndTokens = mapGQLResponseToTarget({ pools:filteredPools }, tokenBody.data);

  const borrowables: Borrowable[] = JSON.parse(process.env.BORROWABLES!)
  let i;
  let j;
  let tradeMultiplier = 1;
  const arbableRoutes: Route[] = [];
  for (i = 0; i < (borrowables.length * 2); i++) {
    if(i >= borrowables.length) {
      j = i - borrowables.length;
      tradeMultiplier = 0.5;
    } else {
      j = i;
    }
    const tradeSize = results.tradeSize[borrowables[j].address].tradeSize * tradeMultiplier;
    const routes = getRoutes({
      inputTokenAmount: BigNumber(tradeSize),
      inputTokenContractAddress: borrowables[j].address,
      outputTokenContractAddress: borrowables[j].address,
      maxHops: 5,
      pairs: formmattedPoolsAndTokens.pairs,
      tokens: formmattedPoolsAndTokens.tokens,
    });
    const filteredRoutes = routes.filter((route) => route.quoteOutputAmount.gt(tradeSize));
    arbableRoutes.push(...filteredRoutes);
    //TEMP
    const sortedRoutes = routes.sort((a, b) => 
      b.quoteOutputAmount.comparedTo(a.quoteOutputAmount) ?? 0
    );
    console.log(sortedRoutes[0], tradeSize);
    //TEMP
  }
  const sortedRoutes = arbableRoutes.sort((a, b) => 
    b.quoteOutputAmount.comparedTo(a.quoteOutputAmount) ?? 0
  );
  console.log(JSON.stringify(sortedRoutes, null, 2));


  console.log((now.getTime() - (new Date()).getTime()) / 1000);

  // If tx threshold is not met
  if(arbableRoutes.length === 0) {
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    return;
  }

  /*const baseToken = pool0!.pair[base0Index].custom_token;

  const msgs: MsgExecuteContract<any>[] = [
    new MsgExecuteContract({ 
      sender: client.address, 
      contract_address: process.env.MONEY_MARKET_ADDRESS!,
      code_hash: process.env.MONEY_MARKET_CODE_HASH!,
      msg: { 
        borrow:{
          token: baseToken.contract_addr, 
          amount: input.toFixed(0), 
        } 
      }, 
      sent_funds: [],
    }),
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: baseToken.contract_addr,
      code_hash: baseToken.token_code_hash,
      msg: {
        send: {
          recipient: process.env.ROUTER_ADDRESS!,
          recipient_code_hash: process.env.ROUTER_CODE_HASH!,
          amount: input.toFixed(0),
          msg: encodeJsonToB64({
            swap_tokens_for_exact:{
              expected_return: input.plus(process.env.MINIMUM_PROFIT!).toFixed(0),
              path,
            }
          }),
        }
      }, 
      sent_funds: [],
    }),
    new MsgExecuteContract({ 
      sender: client.address, 
      contract_address: baseToken.contract_addr,
      code_hash: baseToken.token_code_hash,
      msg: {
        send: {
          recipient: process.env.MONEY_MARKET_ADDRESS!,
          recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
          amount: input.plus(process.env.MINIMUM_PROFIT!).toFixed(0),
          msg: encodeJsonToB64({ repay:{} })
        }
      }, 
      sent_funds: [],
    })
  ];

  const executeResponse = await client.tx.broadcast(
    msgs,
    {
      gasLimit: 3_200_000, // 2250000 swap, 400000 borrow, 400000 repay
      feeDenom: 'uscrt',
    },
  )
  if(executeResponse?.transactionHash !== undefined) {
    fs.appendFile('../transactions.txt', 
      `${now.getTime()},${executeResponse.transactionHash},dexArb\n`, 
      (err) => {
        if (err) logger.error('Failed to append transaction hash', now, err);
      }
    );
  }
  if(executeResponse.code === 0) {
    logger.info(`ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash} - Profit: ${
      profit.toNumber()}`, now);
    //logger.info(JSON.stringify(executeResponse.jsonLog, null, 2), now);
    results.successfulTxs += 1;
  } else {
    logger.info(`ATTEMPT FAILED - ${executeResponse.transactionHash} - Profit: ${
      profit.toNumber()}`, now);
    logger.info(JSON.stringify(executeResponse.rawLog), now);
    results.failedTxs += 1;
    results.lastFailure = now.getTime();
  }*/

  fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
}

main().catch((error:any) => { logger.error(error?.message, new Date());});
