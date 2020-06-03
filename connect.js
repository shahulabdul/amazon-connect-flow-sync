const fetch = require('node-fetch')
const AWS = require('aws-sdk');
const FormData = require('form-data');
const puppeteer = require('puppeteer');

const AUTH_TYPE_FORM = Symbol("Form");
const AUTH_TYPE_FEDERATED = Symbol("Federated");

const startBrowser = async ({ chromiumPath } = {}) =>
    await puppeteer.launch({
        headless: true,
        executablePath: chromiumPath,
        args: [
            '--disable-gpu',
            '--renderer',
            '--no-sandbox',
            '--no-service-autorun',
            '--no-experiments',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
        ]
    });

const getAuthType = async instanceAlias => {
    try {
        const form = new FormData();
        form.append('directoryAliasOrId', instanceAlias);
        form.append('landat', '/connect/home');
        const res = await fetch(`https://${instanceAlias}.awsapps.com/connect/login/redirect`, {
            method: 'POST',
            redirect: 'manual',
            body: form
        });
        const redirect = await res.headers.get('Location');
        return redirect === null ? AUTH_TYPE_FEDERATED : AUTH_TYPE_FORM;
    } catch (err) {
        throw new Error(`invalid instance ID: ${instanceAlias}`);
    }
};

const loginForm = async (instanceAlias, username, password, { chromiumPath }) => {
    const browser = await startBrowser({ chromiumPath });
    try {
        const page = await browser.newPage();
        await page.goto(`https://${instanceAlias}.awsapps.com/connect/home`);
        await page.waitForSelector('#wdc_username', { visible: true });
        await page.type('#wdc_username', username);
        await page.type('#wdc_password', password);
        await page.click('#wdc_login_button');
        const success = await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle0' }).then(() => true),
            page.waitForFunction(`document.querySelector('body') && document.querySelector('body').innerHTML.includes('Authentication Failed')`).then(() => false),
        ]);
        if (!success) {
            throw new Error('Invalid username or password');
        }
        const cookies = await page.cookies();
        return cookies.find(c => c.name === "lily-auth-prod-lhr").value;
    } finally {
        await browser.close();
    }
};

const loginFederated = async (instanceId) => {
    const connect = new AWS.Connect();
    const res = await connect.getFederationToken({ InstanceId: instanceId }).promise();
    return res.Credentials.AccessToken;
};

const fetchAuth = token => ({
    headers: {
        cookie: `lily-auth-prod-lhr=${token}`
    },
});

const listFlows = (instanceAlias, token) => async ({ filter }={}) => {
    if (!token) {
        throw new Error('not logged in');
    }
    const filterParam = filter ? `filter=%7B%22name%22:%22${filter}%22%7D&` : ''
    const res = await fetch(`https://${instanceAlias}.awsapps.com/connect/entity-search/contact-flows?${filterParam}&pageSize=100&startIndex=0`, fetchAuth(token));
    const data = await res.json();
    return data.results;
};

const getFlow = (instanceAlias, token) => async ({ arn, contactFlowStatus = 'published', name, description, contactFlowType }) => {
    if (!token) {
        throw new Error('not logged in');
    }
    const res = await fetch(`https://${instanceAlias}.awsapps.com/connect/contact-flows/export?id=${arn}&status=${contactFlowStatus}`, fetchAuth(token));
    const data = await res.json();
    const flow = JSON.parse(data[0].contactFlowContent);
    if (Array.isArray(flow.metadata)) {
        flow.metadata = flow.metadata.reduce((acc, obj) => ({...acc, ...obj}), {})
    }
    flow.metadata.status = data[0].contactFlowStatus;
    flow.metadata.name = name;
    flow.metadata.description = description;
    flow.metadata.type = contactFlowType;
    return flow;
};

const getFlowEditToken = async (instanceAlias, token, flowARN) => {
    const res = await fetch(`https://${instanceAlias}.awsapps.com/connect/contact-flows/edit?id=${flowARN}`, fetchAuth(token));
    const html = await res.text();
    match = html.match(/app\.constant\(\"token\", \"(.+)\"\)/);
    if (match === null) {
        throw new Error('Failed to get edit token');
    }
    return match[1];
};

const uploadFlow = (instanceAlias, token) => async (flowARN, flowJSON, { editToken, publish=false}={}) => {
    if (!editToken) {
        editToken = await getFlowEditToken(instanceAlias, token, flowARN);
    }
    flow = JSON.parse(flowJSON);
    const [arn0, arnInstance, arn1, arnFlow] = flowARN.split('/');
    res = await fetch(`https://${instanceAlias}.awsapps.com/connect/contact-flows/edit?token=${editToken}`, {
        method: 'POST',
        body: JSON.stringify({
            arn: flowARN,
            resourceArn: flowARN,
            resourceId: arnFlow,
            organization: `${arn0}/${arnInstance}`,
            organizationArn: `${arn0}/${arnInstance}`,
            organizationResourceId: arnInstance,
            contactFlowType: flow.metadata.type,
            contactFlowContent: flowJSON,
            contactFlowStatus: publish ? 'published' : 'saved',
            name: flow.metadata.name,
            description: flow.metadata.description,
            isDefault: false,
        }),
        headers: {
            "content-type": "application/json;charset=UTF-8",
            ...fetchAuth(token).headers
        },
    });
    if (res.status >= 400) {
        throw new Error(`status ${res.status}`)
    }
    if (!res.headers.get('Content-Type').startsWith("application/json")) {
        throw new Error(`html response`);
    }
};

module.exports = async (instanceAlias, { chromiumPath, username, password, instanceId }) => {
    const auth = await getAuthType(instanceAlias);
    let token;
    if (auth == AUTH_TYPE_FEDERATED) {
        token = await loginFederated(instanceId);
    } else {
        token = await loginForm(instanceAlias, username, password, { chromiumPath });
    }
    return {
        listFlows: listFlows(instanceAlias, token),
        getFlow: getFlow(instanceAlias, token),
        uploadFlow: uploadFlow(instanceAlias, token),
    };
};

module.exports.AUTH_TYPE_FORM = AUTH_TYPE_FORM;
module.exports.AUTH_TYPE_FEDERATED = AUTH_TYPE_FEDERATED;
module.exports.getAuthType = getAuthType;
