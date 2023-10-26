import { VercelRequest, VercelResponse } from "@vercel/node";
import { SyndicateClient } from "@syndicateio/syndicate-node";

const syndicate = new SyndicateClient({
  token: process.env.SYNDICATE_API_KEY,
});

export default async function (req: VercelRequest, res: VercelResponse) {
  try {
    // Burn the Circularity NFT from the prior month, minting the next month in
    // the process
    const burnTx = await syndicate.transact.sendTransaction({
      projectId: "2bee69fa-0e96-42cb-a864-8e7258a044a3",
      contractAddress: "0x8680db891ff8c34f2ffcefac43d55059d010a821",
      chainId: 1,
      functionSignature: "burn()",
    });

    // Mint the Circularity Burn Ceremony NFT for the current month
    // A higher amount could be passed in manually if this falls behind via
    // query params, but this won't be needed now
    const mintTx = await syndicate.transact.sendTransaction({
      projectId: "2bee69fa-0e96-42cb-a864-8e7258a044a3",
      contractAddress: "0x83cc08E3783E9fF097e87a63BEc7503465C84714",
      chainId: 1,
      functionSignature: "mint(uint256 amount)",
      args: {
        amount: 1,
      },
    });

    res.status(200).send(
      `<b>Transaction submitted! Transaction IDs Received:</b>
        <br>Circularity Burn: ${burnTx.transactionId}
        <br>Circularity Burn Ceremony Mint: ${mintTx.transactionId}`
    );
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
}
