const abi = require("./abi.json");
import { multiCall, call } from "@defillama/sdk/build/abi/index";
import {
  addToDBWritesList,
  getTokenAndRedirectData,
} from "../../utils/database";
import { getTokenInfo } from "../../utils/erc20";
import { CoinData, Write } from "../../utils/dbInterfaces";
import { Result } from "../../utils/sdkInterfaces";
import { listUnknownTokens } from "../../utils/erc20";
import getBlock from "../../utils/block";

async function getReserveData(
  chain: string,
  block: number | undefined,
  registry: string,
  version: string
) {
  const addressProvider = (
    await call({
      target: registry,
      chain: chain as any,
      abi: abi.getAddressesProviderList,
      block,
    })
  ).output;
  const lendingPool = (
    await call({
      target: addressProvider[0],
      chain: chain as any,
      abi: abi.getPool[version.toLowerCase()],
      block,
    })
  ).output;
  const reservesList = (
    await call({
      target: lendingPool,
      chain: chain as any,
      abi: abi.getReservesList,
      block,
    })
  ).output;
  return (
    await multiCall({
      calls: reservesList.map((r: string) => ({
        target: lendingPool,
        params: [r],
      })),
      abi: abi.getReserveData[version.toLowerCase()],
      chain: chain as any,
      block,
    })
  ).output;
}
let unknownTokens: string[] = [];

export default async function getTokenPrices(
  chain: string,
  registry: string,
  stataRegistry: string,
  version: string,
  timestamp: number
) {
  const block: number | undefined = await getBlock(chain, timestamp);
  const reserveData: Result[] = await getReserveData(
    chain,
    block,
    registry,
    version
  );

  const [underlyingRedirects, tokenInfo] = await Promise.all([
    getTokenAndRedirectData(
      reserveData.map((r: Result) => {
        return r.input.params[0].toLowerCase();
      }),
      chain,
      timestamp
    ),
    getTokenInfo(
      chain,
      reserveData.map((r: Result) => r.output.aTokenAddress),
      block
    ),
  ]);

  let writes: Write[] = [];
  reserveData.map((r, i) => {
    const underlying: CoinData = underlyingRedirects.filter(
      (u) => u.address == r.input.params[0].toLowerCase()
    )[0];

    if (underlying == null) return;

    const redirect =
      underlying.redirect == undefined
        ? `asset#${underlying.chain}:${underlying.address}`
        : underlying.redirect;

    addToDBWritesList(
      writes,
      chain,
      r.output.aTokenAddress.toLowerCase(),
      undefined,
      tokenInfo.decimals[i].output,
      tokenInfo.symbols[i].output,
      timestamp,
      "aave",
      1,
      redirect
    );
  });

  if (stataRegistry) {
    const stata = await getStataAssetPrices(chain, stataRegistry, block);
    const info = await getTokenInfo(
      chain,
      stata.map((r) => r.address),
      block
    );
    stata.map((cfg, ix) => {
      addToDBWritesList(
        writes,
        chain,
        cfg.address,
        undefined,
        info.decimals[ix].output,
        info.symbols[ix].output,
        timestamp,
        "aave",
        1,
        undefined
      );
    });
  }

  await listUnknownTokens(chain, unknownTokens, block);
  return writes;
}

export async function getStataAssetPrices(
  chain: string,
  stataRegistry: string,
  block: number | undefined
) {
  const stataTokens: string[] = (
    await call({
      target: stataRegistry,
      chain: chain as any,
      abi: abi.getStaticATokens,
      block,
    })
  ).output;

  const underlyings: string[] = (
    await multiCall({
      calls: stataTokens.map((token: string) => ({
        target: token,
        params: [],
      })),
      abi: abi.getStaticATokenUnderlying,
      chain: chain as any,
      block,
    })
  ).output;

  const rates: bigint[] = (
    await multiCall({
      calls: stataTokens.map((token: string) => ({
        target: token,
        params: [],
      })),
      abi: abi.getStaticATokenRate,
      chain: chain as any,
      block,
    })
  ).output;

  return stataTokens.map((token: string, ix) => {
    return { address: token, underlying: underlyings[ix], rate: rates[ix] };
  });
}
