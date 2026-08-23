// Deploys EvidenceRegistry and writes the address + ABI to blockchain/deployments/
// so the backend picks it up without copy-paste.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network amoy

const fs = require('fs');
const path = require('path');
const { ethers, network, artifacts } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  const currency = network.name === 'amoy' ? 'POL' : 'ETH';

  console.log(`network   ${network.name} (chainId ${network.config.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} ${currency}`);

  if (balance === 0n) {
    throw new Error(
      `Deployer has no ${currency} on ${network.name}. ` +
        'For Amoy, fund it at https://faucet.polygon.technology first; ' +
        'for local, start `npx hardhat node`.'
    );
  }

  const Factory = await ethers.getContractFactory('EvidenceRegistry');
  const registry = await Factory.deploy(deployer.address);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  const tx = registry.deploymentTransaction();
  const receipt = tx ? await tx.wait() : null;

  console.log(`\ncontract  ${address}`);
  if (receipt) {
    console.log(`tx        ${receipt.hash}`);
    console.log(`block     ${receipt.blockNumber}`);
  }
  if (network.name === 'amoy') {
    console.log(`explorer  https://amoy.polygonscan.com/address/${address}`);
  }

  // The deployer holds REGISTRAR_ROLE and is the backend relayer in this
  // prototype. Investigator wallets are granted the role per demo need.
  const { abi } = await artifacts.readArtifact('EvidenceRegistry');
  const outDir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(outDir, { recursive: true });

  const record = {
    network: network.name,
    chainId: Number(network.config.chainId),
    address,
    deployer: deployer.address,
    txHash: receipt ? receipt.hash : null,
    blockNumber: receipt ? receipt.blockNumber : null,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(outDir, 'EvidenceRegistry.abi.json'), JSON.stringify(abi, null, 2));

  console.log(`\nwrote     deployments/${network.name}.json`);
  console.log(`wrote     deployments/EvidenceRegistry.abi.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
