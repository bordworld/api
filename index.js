require("dotenv").config();
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const { Web3 } = require("web3");
const { Bot, InputFile } = require("grammy");
const bodyParser = require("body-parser");
const { rateLimit } = require("express-rate-limit");

const app = express();
const port = 3001;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(cors());
app.use(bodyParser.json());
app.use(limiter);

// Create an instance of the `Bot` class and pass your bot token to it.
const tgBot = new Bot(process.env.TELEGRAM_API);

const JWT_SECRET = process.env.JWT_SECRET;
const web3 = new Web3(
  `${process.env.ALCHEMY_API_URL}/${process.env.ALCHEMY_API_KEY}`
);

const { nftContractABI, tokenContractABI } = require("./helper.js");

const metadataRarityMappings = {
  Gold: "https://dev.lordy.guide/metadatas/gold.json",
  Silver: "https://dev.lordy.guide/metadatas/silver.json",
  Bronze: "https://dev.lordy.guide/metadatas/bronze.json",
};

const nftContractAddress = process.env.NFT_CONTRACT_ADDRESS;
const nftContract = new web3.eth.Contract(nftContractABI, nftContractAddress);

const tokenContractAddress = process.env.TOKEN_CONTRACT_ADDRESS;
const tokenContract = new web3.eth.Contract(
  tokenContractABI,
  tokenContractAddress
);

const account = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);

const users = []; // Dummy users data

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Endpoint to generate token upon quiz completion
app.post("/complete-quiz", (req, res) => {
  const { score } = req.body;

  if (score === 100) {
    const token = jwt.sign({ score: 100 }, JWT_SECRET, { expiresIn: "2m" });
    res.json({ token });
  } else {
    res.status(400).send();
  }
});

// Mint NFT endpoint (protected)
app.post("/mint-nft", authenticateToken, async (req, res) => {
  const { rarity, walletAddress } = req.body;
  try {
    //Check if the wallet address already has an NFT with the specified rarity
    const hasRarity = await nftContract.methods
      .hasRarity(walletAddress, rarity)
      .call();
    if (hasRarity) {
      return res.status(400).send({
        success: false,
        message: "Wallet already owns an NFT with this rarity.",
      });
    }

    let metadataUrl = metadataRarityMappings[rarity];
    // Mint the NFT with the metadata URI
    const tx = nftContract.methods.safeMint(walletAddress, metadataUrl, rarity);
    const gas = await tx.estimateGas({ from: account.address });
    const gasPrice = await web3.eth.getGasPrice();
    const data = tx.encodeABI();
    const nonce = await web3.eth.getTransactionCount(account.address);

    const signedTx = await web3.eth.accounts.signTransaction(
      {
        to: nftContractAddress,
        data,
        gas,
        gasPrice,
        nonce,
        chainId: process.env.CHAINID, //84532 - Sepolia, 8453 - Base
      },
      process.env.PRIVATE_KEY
    );

    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction
    );

    // Now that the NFT is minted, send tokens
    // Before that, check if sending is enabled
    const sendTokens = process.env.SENDING_TOKENS;
    if (sendTokens == "true") {
      let amountToSend = 0;
      switch (rarity) {
        case "Gold":
          amountToSend = 300;
          break;
        case "Silver":
          amountToSend = 200;
          break;
        case "Bronze":
          amountToSend = 100;
          break;
        default:
          amountToSend = 0;
      }

      if (amountToSend > 0) {
        const tokenAmount = web3.utils.toBigInt(amountToSend * 10 ** 18);
        const tokenTx = tokenContract.methods.transfer(
          walletAddress,
          tokenAmount
        );
        const tokenGas = await tokenTx.estimateGas({ from: account.address });
        const tokenGasPrice = await web3.eth.getGasPrice();
        const tokenData = tokenTx.encodeABI();
        const tokenNonce = await web3.eth.getTransactionCount(account.address);

        const signedTokenTx = await web3.eth.accounts.signTransaction(
          {
            to: tokenContractAddress,
            data: tokenData,
            gas: tokenGas,
            gasPrice: tokenGasPrice,
            nonce: tokenNonce,
            chainId: process.env.CHAINID, //84532 - Sepolia, 8453 - Base
          },
          process.env.PRIVATE_KEY
        );

        const tokenReceipt = await web3.eth.sendSignedTransaction(
          signedTokenTx.rawTransaction
        );
      }
    }

    let txUrl = "https://basescan.org/tx/" + receipt.transactionHash;

    await tgBot.api.sendVideo(
      process.env.TELEGRAM_CHAT_ID,
      new InputFile(new URL(process.env.TELEGRAM_VIDEO_URL)),
      {
        caption: `🚀 New Lordy Guide NFT minted!\n\n🔗 [Transaction](${txUrl})`,
        parse_mode: "markdown",
      }
    );

    res
      .status(200)
      .send({ success: true, transactionHash: receipt.transactionHash });
  } catch (error) {
    console.log(error);
    res.status(500).send({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
