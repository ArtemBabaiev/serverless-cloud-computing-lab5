'use strict';

const yup = require('yup');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");


const postOrgSchema = yup.object({
  name: yup.string().required('Name is required'),
  description: yup.string().required('Description is required')
});

const postUserSchema = yup.object({
  name: yup.string().required('Name is required'),
  email: yup.string().email('Invalid email').required('Email is required'),
});


const client = new DynamoDBClient({
  region: 'localhost',
  endpoint: 'http://0.0.0.0:8000',
  credentials: {
    accessKeyId: 'MockAccessKeyId',
    secretAccessKey: 'MockSecretAccessKey'
  },
});

const docClient = DynamoDBDocumentClient.from(client);

module.exports.postOrganization = async (event) => {
  try {
    let body = extractBody(event)
    let organization = validate(body, postOrgSchema);

    const orgId = uuidv4();

    let res = await performCommand(PutCommand,
      {
        TableName: 'organizationsTable',
        Item: {
          orgId: orgId,
          ...organization
        }
      }
    )
    
    return getResponseObject(200, { orgId: orgId })
  } catch (error) {
    return errorHanlder(error);
  }
};

module.exports.postUser = async (event) => {
  try {
    const orgId = event.pathParameters.orgId;

    let getOrgResult = await performCommand(GetCommand,
      {
        TableName: 'organizationsTable',
        Key: {
          orgId: orgId
        }
      }
    );

    if (!getOrgResult.Item) {
      throw new RequestException(400, "Organization not found");
    }

    let body = extractBody(event)

    let user = validate(body, postUserSchema);

    let queryResult = await performCommand(QueryCommand,
      {
        TableName: 'usersTable',
        IndexName: 'orgId-email-index',
        KeyConditionExpression: 'orgId = :orgId AND email = :email',
        ExpressionAttributeValues: {
          ':orgId': orgId,
          ':email': user.email
        }
      }
    );

    if (queryResult.Items.length > 0) {
      throw new RequestException(400, "User with this email already exists in the organization");
    }

    const userId = uuidv4();

    await performCommand(PutCommand, {
      TableName: 'usersTable',
      Item: {
        userId: userId,
        orgId: orgId,
        ...user
      }
    })

    return getResponseObject(200, { userId: userId })
  } catch (error) {
    return errorHanlder(error)
  }
}



function getResponseObject(code, body) {
  return {
    statusCode: code,
    body: JSON.stringify(body)
  }
}

function extractBody(event) {
  try {
    return JSON.parse(event.body)
  } catch (error) {
    throw new RequestException(400, "Invalid Json body");
  }
}

function validate(obj, schema) {
  try {
    return schema.validateSync(obj, { abortEarly: false , strict: true })
  } catch (error) {
    throw new RequestException(400, error.errors.join(" "));
  }
}

function errorHanlder(error) {
  if (error instanceof RequestException) {
    return getResponseObject(error.code, {
      message: error.message
    })
  }
  console.log(error);
  return getResponseObject(500, {
    message: error.message
  })
}

function performCommand(CommandClass, params) {
  return docClient.send(new CommandClass(params));
}

class RequestException extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}