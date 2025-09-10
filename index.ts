import { config } from 'dotenv';
import {
  MsgExecuteContract,
  SecretNetworkClient,
  Wallet, 
} from 'secretjs';
import * as fs from 'fs';
import BigNumber from 'bignumber.js';

// Core CPMM swap function
function cppm(
  baseIn: BigNumber,
  base: BigNumber,
  x: BigNumber,
  fee: BigNumber
): BigNumber {
  const xOut = x.minus(base.times(x).div(base.plus(baseIn)));
  const feeAmount = xOut.times(fee);
  return xOut.minus(feeAmount);
}

function cppm2(
  baseIn: BigNumber,
  base0: BigNumber,
  x0: BigNumber,
  fee0: BigNumber,
  x1: BigNumber,
  base1: BigNumber,
  fee1: BigNumber,
): BigNumber {
  const xOut = cppm(baseIn, base0, x0, fee0);
  console.log('stkd',xOut.toString());
  const baseOut = cppm(xOut, x1, base1, fee1);
  console.log('usdc',baseOut.toString());
  return baseOut.minus(baseIn);
}

function computeBaseIn(
  poolBuy1: BigNumber,
  poolSell1: BigNumber,
  poolBuy2: BigNumber,
  poolSell2: BigNumber
): BigNumber {
  const pb1 = poolBuy1;
  const ps1 = poolSell1;
  const pb2 = poolBuy2;
  const ps2 = poolSell2;

  const numerator = new BigNumber("9.380602724198101e-6").times(
    new BigNumber("-1.06613651635e11").times(pb1).times(ps1).times(ps2)
      .plus(new BigNumber("-1.06934455e11").times(ps1).times(ps2.pow(2)))
      .plus(
        new BigNumber("1.0660297422966704e8").times(
          new BigNumber(
            new BigNumber(994009)
              .times(pb1.pow(3))
              .times(ps1)
              .times(pb2)
              .times(ps2)
              .plus(
                new BigNumber("1.994e6")
                  .times(pb1.pow(2))
                  .times(ps1)
                  .times(pb2)
                  .times(ps2.pow(2))
              )
              .plus(
                new BigNumber("1e6")
                  .times(pb1)
                  .times(ps1)
                  .times(pb2)
                  .times(ps2.pow(3))
              )
          ).sqrt()
        )
      )
  );

  const denominator = new BigNumber(994009)
    .times(pb1.pow(2))
    .plus(new BigNumber("1.994e6").times(pb1).times(ps2))
    .plus(new BigNumber("1e6").times(ps2.pow(2)));

  return numerator.div(denominator);
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
}

type BatchQueryResponse = {
  batch: {
    block_height: number,
    responses: {
      id: string,
      contract: {
        address: string,
        code_hash: string,
      },
      response: {
        response: string,
      },
    }[],
  },
}

type PoolInfo = {
  pair: {
    custom_token: {
      contract_addr: string,
      token_code_hash: string,
    },
  }[],
  [key: `amount_${number}`]: string,
}

type AdmtPool = {
  assets:{
    info:{
      token:{
        contract_addr:string,
        token_code_hash:string,
        viewing_key:string,
      },
    },
    amount:string,
  }[],
  total_share:string,
}

config({ path: ['./.env', './.env.admtfi'] });

if(!process.env.LCD_NODE 
   || !process.env.CHAIN_ID
   || !process.env.PRIVATE_KEY
   || !process.env.WALLET_ADDRESS
   || !process.env.BATCH_QUERY_CONTRACT
   || !process.env.POOL_0
   || !process.env.POOL_1
   || !process.env.POOL_2
   || !process.env.MONEY_MARKET_ADDRESS
   || !process.env.ROUTER_ADDRESS
   || !process.env.MINIMUM_PROFIT
   || !process.env.BORROW_AMOUNT
  ) {
  //throw new Error('Missing env variables are required in the .env file');
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
    };
    fs.writeFileSync(`./results.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./results.txt`, 'utf-8');
  const results: Results = JSON.parse(resultsUnparsed);

  const now = new Date();

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

  const queryMsg = {
    batch: {
      queries: [{
        id: encodeJsonToB64(`SHADESWAP_AMM`),
        contract: {
          address: process.env.SHADESWAP_AMM,
          code_hash: process.env.SHADESWAP_AMM_HASH,
        },
        query: encodeJsonToB64({ get_pair_info: {}, }),
      },{
        id: encodeJsonToB64(`ADMT_AMM`),
        contract: {
          address: process.env.ADMT_AMM,
          code_hash: process.env.ADMT_AMM_HASH,
        },
        query: encodeJsonToB64({ pool: {}, }),
      },{
        id: encodeJsonToB64(`USDC_TO_SILK`),
        contract: {
          address: process.env.USDC_TO_SILK,
          code_hash: process.env.USDC_TO_SILK_HASH,
        },
        query: encodeJsonToB64({
         swap_simulation:{
           offer:{
            token:{
             custom_token:{
                  contract_addr:"secret1chsejpk9kfj4vt9ec6xvyguw539gsdtr775us2", 
                  token_code_hash:"5a085bd8ed89de92b35134ddd12505a602c7759ea25fb5c089ba03c8535b3042"
                } 
              }, amount: "100000"
            } 
          } 
        } ),
      },{
        id: encodeJsonToB64(`SDKT_TO_SCRT`),
        contract: {
          address: process.env.SDKT_TO_SCRT,
          code_hash: process.env.SDKT_TO_SCRT_HASH,
        },
        query: encodeJsonToB64({
         swap_simulation:{
           offer:{
            token:{
             custom_token:{
                  contract_addr:"secret1k6u0cy4feepm6pehnz804zmwakuwdapm69tuc4", 
                  token_code_hash:"f6be719b3c6feb498d3554ca0398eb6b7e7db262acb33f84a8f12106da6bbb09"
                } 
              }, amount: "100000"
            } 
          } 
        } ),
      }],
    }
  };

  const beforeQuery = new Date().getTime();
  let queryResponse;
  try {
    queryResponse = await client.query.compute.queryContract({
      contract_address: process.env.BATCH_QUERY_CONTRACT!,
      code_hash: process.env.BATCH_QUERY_HASH,
      query: queryMsg,
    }) as BatchQueryResponse;
  } catch (e: any)  {
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }
  if(queryResponse === undefined || queryResponse === null) {
    results.failedQueries += 1;
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    return;
  }
  const queryLength = (new Date().getTime() - beforeQuery) / 1000;
  results.queryLength.push(queryLength);
  if(results.queryLength.length > 100) {
    // Keep the last 100 query lengths for average calculation
    results.queryLength.shift();
  }

  let pool0: PoolInfo | undefined;
  let pool1: AdmtPool | undefined;
  let usdcToSilkRate: BigNumber | undefined;
  let sdktToScrtRate: BigNumber | undefined;

  queryResponse.batch.responses.forEach((query) => {
    const queryData = decodeB64ToJson(query.response.response);
    const queryKey = decodeB64ToJson(query.id);
    console.log(queryKey, JSON.stringify(queryData));
    if(queryKey === 'SHADESWAP_AMM') {
      pool0 = queryData.get_pair_info;
    } else if(queryKey === 'ADMT_AMM') {
      pool1 = queryData;
    } else if(queryKey === 'USDC_TO_SILK') {
      usdcToSilkRate = new BigNumber(queryData.swap_simulation.price);
    } else if(queryKey === 'SDKT_TO_SCRT') {
      sdktToScrtRate = new BigNumber(queryData.swap_simulation.price);
    }
  });

  const admtUsdc = new BigNumber(pool1!.assets.find((next) => next.info.token.contract_addr === process.env.USDC_ADDRESS)!.amount);
  const admtSscrt = pool1!.assets.find((next) => next.info.token.contract_addr === process.env.SSCRT_ADDRESS);
  const admtStkd = BigNumber(admtSscrt!.amount).div(sdktToScrtRate!);
  
  const addrArray = pool0!.pair.map((next) => next?.custom_token?.contract_addr);
  const shadeswapStkdIndex = addrArray.indexOf(process.env.SDKT_ADDRESS!);
  const shadeswapStkd = BigNumber(pool0![`amount_${shadeswapStkdIndex!}`]);
  const shadeswapSilkIndxe = addrArray.indexOf(process.env.SILK_ADDRESS!);
  const shadeswapUsdcAmount = BigNumber(pool0![`amount_${shadeswapSilkIndxe!}`] ).div(usdcToSilkRate!);

  const dir0: Record<string, BigNumber> = {
    usdc0: admtUsdc, 
    stdk0: admtStkd,
    usdc1: shadeswapUsdcAmount,
    stdk1: shadeswapStkd,
  };

  /*const pool2Tokens = pool2!.pair.reduce((prev: string[], curr) => {
    if(curr.custom_token) {
      prev.push(curr.custom_token.contract_addr);
    }
    return prev;
  }, []);
  const base0Index = pool0!.pair.findIndex(
    (next) => pool2Tokens.includes(next?.custom_token?.contract_addr)
  );
  const base0 = BigNumber(pool0![`amount_${base0Index!}`]);
  dir0['base0'] = base0;
  dir1['base2'] = base0;
  const x0Index = base0Index === 0 ? 1 : 0;
  const x0 = BigNumber(pool0![`amount_${x0Index}`]);
  dir0['x0'] = x0;
  dir1['y2'] = x0;

  const x1Index = pool1!.pair.findIndex(
    (next) => pool0!.pair[x0Index].custom_token.contract_addr === next?.custom_token?.contract_addr
  );
  const x1 = BigNumber(pool1![`amount_${x1Index}`]);
  dir0['x1'] = x1;
  dir1['y1'] = x1;
  const y1Index = x1Index === 0 ? 1 : 0;
  const y1 = BigNumber(pool1![`amount_${y1Index}`]);
  dir0['y1'] = y1;
  dir1['x1'] = y1;

  const base2Index = pool2!.pair.findIndex(
    (next) => 
      pool0!.pair[base0Index].custom_token.contract_addr === next?.custom_token?.contract_addr
  );
  const base2 = BigNumber(pool2![`amount_${base2Index}`]);
  dir0['base2'] = base2;
  dir1['base0'] = base2;
  const y2Index = base2Index === 0 ? 1 : 0;
  const y2 = BigNumber(pool2![`amount_${y2Index}`]);
  dir0['y2'] = y2;
  dir1['x0'] = y2;*/

  const fee = BigNumber(0.003);
  console.log('data', JSON.stringify(dir0));

  const dir0Inputs = BigNumber.max(
    1,
    computeBaseIn(dir0.stdk0, dir0.usdc0, dir0.usdc1, dir0.stdk1)
  );
  const dir1Inputs = BigNumber.max( 
    1,
    computeBaseIn(dir0.stdk1, dir0.usdc1, dir0.usdc0, dir0.stdk0)
  );
  // TODO move to results
  const dir0InputsCapped = BigNumber.min(process.env.BORROW_AMOUNT!, dir0Inputs);
  const dir1InputsCapped = BigNumber.min(process.env.BORROW_AMOUNT!, dir1Inputs);

  console.log('Inputs', dir0Inputs.toString(), dir1Inputs.toString());

  const dir0Profit = cppm2(
    dir0InputsCapped, 
    dir0.usdc0, 
    dir0.stdk0, 
    fee, 
    dir0.stdk1, 
    dir0.usdc1, 
    fee, 
  );
  const dir1Profit = cppm2(
    dir1InputsCapped, 
    dir0.usdc1, 
    dir0.stdk1, 
    fee, 
    dir0.stdk0, 
    dir0.usdc0, 
    fee, 
  );
  console.log(dir0Profit.toString(), dir1Profit.toString());

  let profit = dir1Profit;
  let input = dir1InputsCapped;
  let path = [
    {
     addr: process.env.USDC_TO_SILK, code_hash: process.env.USDC_TO_SILK_HASH 
    },
    {
     addr: process.env.SHADESWAP_AMM, code_hash: process.env.SHADESWAP_AMM_HASH 
    },
    {
     addr: process.env.SDKT_TO_SCRT, code_hash: process.env.SDKT_TO_SCRT_HASH 
    },
    {
     addr: process.env.ADMT_AMM, code_hash: process.env.ADMT_AMM_HASH, admt: true
    },
  ];
  if(dir0Profit.gt(dir1Profit)) {
    console.log('HERE');
    profit = dir0Profit;
    input = dir0InputsCapped;
    path = path.reverse();
  }

  /*results.profit.push(profit.toNumber());
  if(results.profit.length > 100) {
    // Keep the last 100 for average calculation
    results.profit.shift();
  }*/

  console.log(profit);

  // If tx threshold is not met
  if(profit.lt(process.env.MINIMUM_PROFIT!)) {
    fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
    return;
  }

  const baseToken = "secret1chsejpk9kfj4vt9ec6xvyguw539gsdtr775us2";
  const baseTokenHash = "5a085bd8ed89de92b35134ddd12505a602c7759ea25fb5c089ba03c8535b3042";

  const msgs: MsgExecuteContract<any>[] = [
    new MsgExecuteContract({ 
      sender: client.address, 
      contract_address: process.env.MONEY_MARKET_ADDRESS!,
      code_hash: process.env.MONEY_MARKET_CODE_HASH!,
      msg: { 
        borrow:{
          token: baseToken, 
          amount: input.toFixed(0), 
        } 
      }, 
      sent_funds: [],
    }),
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: baseToken,
      code_hash: baseTokenHash,
      msg: {
        send: {
          recipient: process.env.ADMT_ROUTER!,
          recipient_code_hash: process.env.ADMT_ROUTER_HASH!,
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
      contract_address: baseToken,
      code_hash: baseTokenHash,
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
  }

  fs.writeFileSync('./results.txt', JSON.stringify(results, null, 2));
}

main().catch((error:any) => { logger.error(error?.message, new Date());});
