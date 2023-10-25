import { VercelRequest, VercelResponse } from "@vercel/node";
import { SyndicateClient } from "@syndicateio/syndicate-node";

const syndicate = new SyndicateClient({ token: "YOUR_ACCESS_TOKEN" });

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    const tx = await syndicate.transact.sendTransaction({
      projectId: "eb7dab54-f66b-4739-8c18-f5a6196f7117",
      contractAddress: "0x4Bc7a03C46c0BBb290d5455ff7f03d30263809e4",
      chainId: 80001,
      functionSignature: "mintTo(address to)",
      args: {
        to: "0x18F33CEf45817C428d98C4E188A770191fDD4B79",
      },
    });

    res.status(200).send(`Transaction ID Received: ${tx.transactionId}`);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
}
