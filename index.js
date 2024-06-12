require('dotenv').config();
const jwt = require('jsonwebtoken');
const express = require('express');
const cors = require('cors');
const { Web3 } = require('web3');
const bodyParser = require('body-parser');
const { rateLimit } = require('express-rate-limit')

const app = express();
const port = 3000;

const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 20, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
})

app.use(cors());
app.use(bodyParser.json());
app.use(limiter);

const JWT_SECRET = process.env.JWT_SECRET;
const web3 = new Web3(`${process.env.ALCHEMY_API_URL}/${process.env.ALCHEMY_API_KEY}`);

const contractABI = require('./helper'); 
const metadataRarityMappings = {
  explorer: "https://dev.bord.world/metadatas/explorer.json",
  knight: "",
  merchant: "",
  gangster: "",
  hunter: "",
  wizard: "",
  lord: ""
};

const contractAddress = process.env.NFT_CONTRACT_ADDRESS;
const contract = new web3.eth.Contract(contractABI, contractAddress);

const account = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
web3.eth.accounts.wallet.add(account);

const users = []; // Dummy users data

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Endpoint to generate token upon quiz completion
app.post('/complete-quiz', (req, res) => {
  const { score } = req.body;

  if (score === 100) {
    const token = jwt.sign({ score: 100 }, JWT_SECRET, { expiresIn: '2m' });
    res.json({ token });
  } else {
    res.status(400).send();
  }
});

// Mint NFT endpoint (protected)
app.post('/mint-nft', authenticateToken, async (req, res) => {
    const { rarity, walletAddress } = req.body;

    try {
      
      // Check if the wallet address already has an NFT with the specified rarity
      const hasRarity = await contract.methods.hasRarity(walletAddress, rarity).call();
      if (hasRarity) {
        return res.status(400).send({ success: false, message: 'Wallet already owns an NFT with this rarity.' });
      }

      let metadataUrl = metadataRarityMappings[rarity];
      // Mint the NFT with the metadata URI
      const tx = contract.methods.safeMint(walletAddress, metadataUrl, rarity);
      const gas = await tx.estimateGas({ from: account.address });
      const gasPrice = await web3.eth.getGasPrice();
      const data = tx.encodeABI();
      const nonce = await web3.eth.getTransactionCount(account.address);

      const signedTx = await web3.eth.accounts.signTransaction(
        {
          to: contractAddress,
          data,
          gas,
          gasPrice,
          nonce,
          chainId: process.env.CHAINID, //84532 - Sepolia, 8453 - Base
        },
        process.env.PRIVATE_KEY
      );

      const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
      res.status(200).send({ success: true, transactionHash: receipt.transactionHash });

    } catch (error) {
      console.log(error);
      res.status(500).send({ success: false, error: error.message });
    }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});