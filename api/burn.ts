import { VercelRequest, VercelResponse } from "@vercel/node";
import { SyndicateClient } from "@syndicateio/syndicate-node";

const syndicate = new SyndicateClient({
  token: process.env.SYNDICATE_API_KEY,
});

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const tx = await syndicate.transact.sendTransaction({
      projectId: "522c30f3-abc4-4423-a315-7a13b56cbb3a",
      contractAddress: "0x8680db891ff8c34f2ffcefac43d55059d010a821",
      chainId: 1,
      functionSignature: "burn()",
    });

    res.status(200).send(`Transaction ID Received: ${tx.transactionId}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
}
