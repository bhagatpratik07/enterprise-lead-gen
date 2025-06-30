import https from "https";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const apolloApiKey = process.env.APOLLO_API_KEY;
const freeDomains = [
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "icloud.com",
  "hotmail.com",
];
const dynamoTableName = process.env.DYNAMO_TABLE_NAME || "EnterpriseSalesLead";
const snsTopicArn = process.env.SNS_TOPIC_ARN;

const dynamo = new DynamoDBClient({ region: "us-east-1" });
const sns = new SNSClient({ region: "us-east-1" });

export const handler = async (event) => {
  try {
    let email;

    if (event?.request?.userAttributes?.email) {
      email = event.request.userAttributes.email;
    } else {
      console.log("Missing email. Skipping enrichment.");
      return event;
    }

    const domain = email.split("@")[1].toLowerCase();

    if (freeDomains.includes(domain)) {
      console.log("Free email domain. Skipping.");
      return event;
    }

    const companyData = await fetchCompanyData(domain);
    if (!companyData?.organization) {
      console.log("No organization data found.");
      return event;
    }

    const org = companyData.organization;
    const hasVideoEditing = org.keywords?.includes("video editing");

    if (!hasVideoEditing) {
      console.log("Industry not matched. Skipping lead creation.");
      return event;
    }

    const leadId = `${org.primary_domain}-${Date.now()}`;
    await dynamo.send(
      new PutItemCommand({
        TableName: dynamoTableName,
        Item: {
          ID: { S: leadId },
          CompanyName: { S: org.name },
          Domain: { S: org.primary_domain },
          Industry: { S: org.industry || "unknown" },
          Email: { S: email },
          Employees: { N: String(org.estimated_num_employees || 0) },
          City: { S: org.city || "unknown" },
          Country: { S: org.country || "unknown" },
          Timestamp: { S: new Date().toISOString() },
        },
      })
    );

    await sns.send(
      new PublishCommand({
        TopicArn: snsTopicArn,
        Subject: `🎯 New Lead: ${org.name}`,
        Message: `New company signup matched lead criteria:\n\nCompany: ${
          org.name
        }\nDomain: ${org.primary_domain}\nIndustry: ${
          org.industry
        }\nEmployees: ${org.estimated_num_employees || "?"}\nEmail: ${email}`,
      })
    );

    console.log("Lead stored and notification sent.");
  } catch (err) {
    console.error("Error in enrichment:", err);
  }

  return event;
};

function fetchCompanyData(domain) {
  const url = `https://api.apollo.io/api/v1/organizations/enrich?domain=${domain}`;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "x-api-key": apolloApiKey,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse JSON: " + e.message));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}
