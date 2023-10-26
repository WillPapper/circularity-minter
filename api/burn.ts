import { VercelRequest, VercelResponse } from "@vercel/node";
import { SyndicateClient } from "@syndicateio/syndicate-node";

const syndicate = new SyndicateClient({
  token: process.env.SYNDICATE_API_KEY,
});

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const tx = await syndicate.transact.sendTransaction({
      projectId: "2bee69fa-0e96-42cb-a864-8e7258a044a3",
      contractAddress: "0x8680db891ff8c34f2ffcefac43d55059d010a821",
      chainId: 1,
      functionSignature: "burn()",
    });

    res.status(200).send(`Transaction ID Received: ${tx.transactionId}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
}
