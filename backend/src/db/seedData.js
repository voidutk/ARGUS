/**
 * Reference data for the seeder.
 *
 * Kept separate from seed.js so the generation logic stays readable. Everything
 * here is synthetic. Names, numbers, accounts and wallets are invented; the
 * geography and the bank/UPI handle formats are real so the demo looks like
 * something an investigator would recognise.
 *
 * Jamtara (Jharkhand) is included deliberately — it is the district India's
 * cyber cells actually associate with phishing call centres, and judges from
 * MHA will notice its absence more than its presence.
 */

// [state, district, lat, lon]
const PLACES = [
  ['Maharashtra', 'Mumbai', 19.076, 72.877],
  ['Maharashtra', 'Pune', 18.520, 73.856],
  ['Maharashtra', 'Nagpur', 21.146, 79.088],
  ['Karnataka', 'Bengaluru', 12.972, 77.594],
  ['Karnataka', 'Mysuru', 12.295, 76.639],
  ['Delhi', 'New Delhi', 28.613, 77.209],
  ['Tamil Nadu', 'Chennai', 13.083, 80.270],
  ['Tamil Nadu', 'Coimbatore', 11.017, 76.956],
  ['Telangana', 'Hyderabad', 17.385, 78.487],
  ['Uttar Pradesh', 'Lucknow', 26.847, 80.947],
  ['Uttar Pradesh', 'Noida', 28.535, 77.391],
  ['Uttar Pradesh', 'Kanpur', 26.450, 80.332],
  ['West Bengal', 'Kolkata', 22.573, 88.364],
  ['Gujarat', 'Ahmedabad', 23.023, 72.571],
  ['Gujarat', 'Surat', 21.170, 72.831],
  ['Rajasthan', 'Jaipur', 26.912, 75.787],
  ['Rajasthan', 'Bharatpur', 27.217, 77.489],
  ['Kerala', 'Kochi', 9.932, 76.267],
  ['Kerala', 'Thiruvananthapuram', 8.524, 76.936],
  ['Punjab', 'Ludhiana', 30.901, 75.857],
  ['Haryana', 'Gurugram', 28.457, 77.026],
  ['Haryana', 'Nuh', 28.107, 77.001],
  ['Madhya Pradesh', 'Bhopal', 23.260, 77.413],
  ['Madhya Pradesh', 'Indore', 22.720, 75.858],
  ['Bihar', 'Patna', 25.594, 85.138],
  ['Odisha', 'Bhubaneswar', 20.296, 85.825],
  ['Assam', 'Guwahati', 26.145, 91.736],
  ['Jharkhand', 'Ranchi', 23.344, 85.310],
  ['Jharkhand', 'Jamtara', 23.955, 86.803],
  ['Andhra Pradesh', 'Visakhapatnam', 17.686, 83.218],
];

const FIRST_NAMES = [
  'Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Anjali', 'Rohit', 'Kavita',
  'Suresh', 'Meera', 'Arjun', 'Divya', 'Manish', 'Pooja', 'Sanjay', 'Nisha',
  'Karthik', 'Shreya', 'Deepak', 'Ritu', 'Ajay', 'Swati', 'Nikhil', 'Aarti',
  'Ramesh', 'Lakshmi', 'Farhan', 'Ayesha', 'Gurpreet', 'Simran', 'Abhishek',
  'Neha', 'Sunil', 'Rekha', 'Vivek', 'Tanvi', 'Harish', 'Bhavna', 'Imran', 'Zoya',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Singh', 'Gupta',
  'Mehta', 'Joshi', 'Desai', 'Kulkarni', 'Chauhan', 'Bose', 'Das', 'Mishra',
  'Rathore', 'Malhotra', 'Khan', 'Sheikh', 'Pillai', 'Menon', 'Yadav', 'Jain',
  'Agarwal', 'Bhatt', 'Kaur', 'Sethi', 'Rao', 'Naidu',
];

const BANKS = [
  ['HDFC Bank', 'HDFC'], ['ICICI Bank', 'ICIC'], ['State Bank of India', 'SBIN'],
  ['Axis Bank', 'UTIB'], ['Kotak Mahindra Bank', 'KKBK'], ['Punjab National Bank', 'PUNB'],
  ['Bank of Baroda', 'BARB'], ['Canara Bank', 'CNRB'], ['Yes Bank', 'YESB'],
  ['IndusInd Bank', 'INDB'],
];

const UPI_HANDLES = [
  'okhdfcbank', 'okaxis', 'oksbi', 'okicici', 'paytm', 'ybl', 'ibl', 'axl', 'upi', 'apl',
];

const EMAIL_DOMAINS = ['gmail.com', 'yahoo.in', 'outlook.com', 'rediffmail.com'];

const CATEGORIES = [
  'UPI_FRAUD', 'INVESTMENT_SCAM', 'DIGITAL_ARREST', 'JOB_FRAUD', 'LOAN_APP',
  'CRYPTO_FRAUD', 'SEXTORTION', 'PHISHING', 'MATRIMONIAL', 'OTP_FRAUD',
];

/**
 * Narrative templates, in the Hinglish a real NCRP filing is written in.
 *
 * Identifiers are interpolated INLINE rather than stored only as columns —
 * that is the point. /extract has to find them in prose on stage, so the prose
 * has to be genuinely messy: +91 prefixes on some numbers and not others, mixed
 * case on UPI handles, "Rs." and "₹" both in play.
 */
const NARRATIVES = {
  INVESTMENT_SCAM: [
    (v) => `I was added to a Telegram group named "${v.groupName}" where they were showing daily profit screenshots. A person calling himself ${v.handlerName} contacted me from ${v.handlerPhone} and told me to invest in their trading platform. I first paid Rs. ${v.amt1} to UPI ID ${v.upi} and got small profit back, so I trusted them. Then I transferred ₹${v.amt2} to account number ${v.account} (${v.bank}, IFSC ${v.ifsc}). After that they asked for more "tax clearance" money and blocked me. Their telegram handle was @${v.telegram}. Total loss ${v.total} rupees.`,
    (v) => `Sir, I saw an advertisement on Instagram about stock market training. I called on ${v.handlerPhone} and one lady said her name is ${v.handlerName}. She sent me a link to install their app. I paid ${v.amt1} rupees through UPI ${v.upi} for registration. Later she said my profit of 4 lakh is ready but I have to pay GST first, so I sent ₹${v.amt2} to ${v.bank} account ${v.account}. Now number is switched off. I have all screenshots. My login was showing from IP ${v.ip}.`,
    (v) => `Maine ek investment group join kiya tha jisme ${v.handlerName} naam ka aadmi tha, uska number ${v.handlerPhone} hai. Usne bola ki daily 3% return milega. Maine pehle Rs ${v.amt1} bheja us UPI par - ${v.upi}. Phir usne bola aur paisa dalo to maine ₹${v.amt2} transfer kiya account ${v.account} me (${v.bank}). Ab wo log group se nikal diye mujhe. Telegram id @${v.telegram} thi unki.`,
  ],
  DIGITAL_ARREST: [
    (v) => `I received a video call from ${v.handlerPhone}. The person was wearing police uniform and said he is from CBI Mumbai. He said a parcel in my name contains drugs and my Aadhaar is used in money laundering. He kept me on video call for 6 hours and did not allow me to talk to family. He said I have to transfer money for "verification" and it will be returned. I transferred ₹${v.amt2} to account ${v.account} of ${v.bank}, IFSC ${v.ifsc}. He also took ${v.amt1} through UPI ${v.upi}. Later I understood it is fraud.`,
    (v) => `Sir mujhe ${v.handlerPhone} se call aaya, bola ki main Delhi Cyber Cell se ${v.handlerName} bol raha hoon. Unhone kaha mere naam se FIR hui hai aur digital arrest kar rahe hain. Poore din video call par rakha. Dar ke maare maine ₹${v.amt2} transfer kar diya account number ${v.account} me. Unhone ek aur ${v.amt1} rupaye UPI ${v.upi} par mangwaye. Email bhi aaya tha ${v.email} se jisme fake warrant tha.`,
    (v) => `A person called from ${v.handlerPhone} claiming to be from Telecom Department and said my SIM is being used for illegal activity. Then he connected the call to someone claiming to be ${v.handlerName}, an officer. They sent a fake arrest warrant from email ${v.email}. Under pressure I paid Rs ${v.amt2} to ${v.account} (${v.bank}). The call was made over internet, my provider showed connection from ${v.ip}.`,
  ],
  CRYPTO_FRAUD: [
    (v) => `I was contacted on WhatsApp from ${v.handlerPhone} regarding a crypto arbitrage opportunity. They asked me to first send ₹${v.amt2} to ${v.bank} account ${v.account}, and later told me to buy USDT and transfer to wallet address ${v.wallet}. The dashboard showed my balance growing but withdrawal never worked. Their telegram was @${v.telegram}. I also paid ${v.amt1} via UPI ${v.upi} as "gas fee".`,
    (v) => `Maine ek crypto trading site par account banaya tha, mujhe ${v.handlerName} ne ${v.handlerPhone} se guide kiya. Pehle ₹${v.amt1} UPI ${v.upi} se bheja, phir unhone bola ki apna USDT is wallet par bhejo - ${v.wallet}. Maine total ${v.total} rupaye ka crypto bhej diya. Ab website band ho gayi hai. Unka email ${v.email} tha.`,
  ],
  UPI_FRAUD: [
    (v) => `I had listed my sofa on OLX. A buyer called from ${v.handlerPhone} saying he is army personnel posted at a camp. He sent me a QR code and asked me to scan to "receive" the payment. When I scanned and entered PIN, ₹${v.amt2} was debited instead of credited. He then said it was a mistake and made me scan again, losing ${v.amt1} more. Money went to UPI ID ${v.upi}.`,
    (v) => `Sir maine apna phone OLX par becha tha. Buyer ne ${v.handlerPhone} se call kiya aur bola ki main CRPF me hoon. Usne ek QR code bheja aur bola scan karo paisa aa jayega. Maine scan kiya to mere account se ₹${v.amt2} kat gaye. UPI id ${v.upi} thi jahan paisa gaya. Phir usne dobara try karwaya aur ${v.amt1} aur gaye.`,
    (v) => `Received a call from ${v.handlerPhone} claiming to be from my bank's KYC department. He said my account will be blocked and asked me to update KYC through a link. After I entered details, ₹${v.amt2} was debited to ${v.upi}. My registered email ${v.email} also received a login alert from IP ${v.ip}.`,
  ],
  JOB_FRAUD: [
    (v) => `I applied for a work-from-home data entry job seen on a job portal. ${v.handlerName} called me from ${v.handlerPhone} and asked for a registration fee of Rs ${v.amt1} which I paid to UPI ${v.upi}. Then they said I have to pay security deposit of ₹${v.amt2} to account ${v.account} of ${v.bank}. After paying, no work was given and number stopped responding. Offer letter came from ${v.email}.`,
    (v) => `Mujhe telegram par part time job ka message aaya, task complete karne par paisa milega. Pehle 2-3 task ka paisa aaya. Phir bole ki bade task ke liye deposit karna padega. Maine ₹${v.amt2} bheja account ${v.account} me aur ${v.amt1} UPI ${v.upi} par. Uske baad account freeze bata diya. Handler ka number ${v.handlerPhone} hai, telegram @${v.telegram}.`,
  ],
  LOAN_APP: [
    (v) => `I downloaded an instant loan app and took a small loan of ${v.amt1} rupees. They accessed my contacts and photos. Even after repaying to UPI ${v.upi}, they demanded ₹${v.amt2} more and threatened to send morphed photos to my contacts. Calls came from ${v.handlerPhone}. They asked payment to ${v.bank} account ${v.account}.`,
    (v) => `Loan app se ${v.amt1} ka loan liya tha. Repay karne ke baad bhi ${v.handlerPhone} se dhamki bhare call aa rahe hain. Unhone mere contacts ko message bheja. Aur ₹${v.amt2} maang rahe hain UPI ${v.upi} par. Recovery agent ka naam ${v.handlerName} bataya.`,
  ],
  SEXTORTION: [
    (v) => `I received a video call from an unknown number ${v.handlerPhone}. A woman appeared and the call was recorded. Later a person called saying he is from cyber cell and demanded money to delete the video. I paid ₹${v.amt2} to UPI ${v.upi} and then ${v.amt1} more to account ${v.account}. They are still demanding. Their email is ${v.email}.`,
  ],
  PHISHING: [
    (v) => `I received an SMS saying my electricity connection will be disconnected tonight and to call ${v.handlerPhone}. When I called, the person asked me to install a screen sharing app to "verify" my bill payment. After that ₹${v.amt2} was debited from my ${v.bank} account. The transaction shows UPI ${v.upi}. Login alert showed IP ${v.ip}.`,
    (v) => `Mujhe SMS aaya ki bank KYC expire ho gaya hai, link par click kiya to ek page khula bank jaisa. Maine details daal di. Turant ₹${v.amt2} kat gaye. Customer care ka number SMS me ${v.handlerPhone} tha jo fake nikla. Paisa ${v.upi} par gaya.`,
  ],
  MATRIMONIAL: [
    (v) => `I met a person on a matrimonial site who said he is an NRI doctor. We talked for 3 months from ${v.handlerPhone}. He said he is sending gifts and I got a call about customs clearance. I paid ₹${v.amt2} to account ${v.account} of ${v.bank} and ${v.amt1} to UPI ${v.upi}. After that he blocked me everywhere. His email was ${v.email}.`,
  ],
  OTP_FRAUD: [
    (v) => `I received a call from ${v.handlerPhone} saying they are calling from the bank regarding my credit card reward points which are expiring. He asked me to share the OTP to redeem. As soon as I shared it, ₹${v.amt2} was debited. The merchant shown was a UPI transfer to ${v.upi}.`,
    (v) => `Bank ka call bola tha, ${v.handlerPhone} se. Card block ho raha hai bolke OTP maanga. Maine bata diya to ₹${v.amt2} ka transaction ho gaya. Baad me ${v.amt1} ka aur try kiya. Paisa ${v.upi} par gaya hai.`,
  ],
};

const TELEGRAM_GROUP_NAMES = [
  'NIFTY VIP Signals', 'Wealth Builders India', 'Crypto Profit Zone',
  'Stock Guru Premium', 'Daily Earning Club', 'Forex Master Class',
];

const UNITS = [
  ['Cyber Crime Police Station, Bengaluru', 'CCPS-BLR', 'Karnataka', 'Bengaluru'],
  ['Cyber Crime Cell, Mumbai', 'CCPS-MUM', 'Maharashtra', 'Mumbai'],
  ['Cyber Crime Unit, New Delhi', 'CCPS-DEL', 'Delhi', 'New Delhi'],
  ['Cyber Crime Police Station, Hyderabad', 'CCPS-HYD', 'Telangana', 'Hyderabad'],
  ['National Cybercrime Coordination Centre', 'I4C-HQ', 'Delhi', 'New Delhi'],
];

module.exports = {
  PLACES, FIRST_NAMES, LAST_NAMES, BANKS, UPI_HANDLES, EMAIL_DOMAINS,
  CATEGORIES, NARRATIVES, TELEGRAM_GROUP_NAMES, UNITS,
};
