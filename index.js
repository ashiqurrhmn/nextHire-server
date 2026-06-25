require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.get("/", (req, res) => {
  res.send("Hello World!");
});

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const dbName = process.env.DB_NAME || "next-hire-auth";
    const database = client.db(dbName);
    const jobsCollection = database.collection("jobs");
    const companiesCollection = database.collection("companies");
    const usersCollection = database.collection("user");
    const applicationsCollection = database.collection("applications");
    const plansCollection = database.collection("plans");
    const subscriptionsCollection = database.collection("subscriptions");
    const savedJobsCollection = database.collection("savedJobs");

    app.get('/api/users', async (req, res) => {
      const query = {};
      if (req.query.role) {
        query.role = req.query.role;
      }
      const cursor = usersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Admin: Update user role
    app.patch('/api/users/:id/role', async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      if (!role || !['seeker', 'recruiter', 'admin'].includes(role)) {
        return res.status(400).send({ error: "Invalid role. Must be 'seeker', 'recruiter', or 'admin'." });
      }
      let filter;
      try {
        filter = { _id: new ObjectId(id) };
      } catch(e) {
        filter = { id: id };
      }
      const updateResult = await usersCollection.updateOne(filter, {
        $set: { role: role, updatedAt: new Date() }
      });
      if (updateResult.matchedCount === 0) {
        // Try with 'id' field (better-auth uses 'id' not '_id')
        const retryResult = await usersCollection.updateOne({ id: id }, {
          $set: { role: role, updatedAt: new Date() }
        });
        if (retryResult.matchedCount === 0) {
          return res.status(404).send({ error: "User not found" });
        }
      }
      res.send({ success: true, role: role });
    });

    // Admin: Delete a user
    app.delete('/api/users/:id', async (req, res) => {
      const id = req.params.id;
      let result;
      try {
        result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
      } catch(e) {
        result = await usersCollection.deleteOne({ id: id });
      }
      if (result.deletedCount === 0) {
        // Try with 'id' field
        result = await usersCollection.deleteOne({ id: id });
        if (result.deletedCount === 0) {
          return res.status(404).send({ error: "User not found" });
        }
      }
      res.send({ success: true });
    });

    app.get('/api/jobs', async (req, res) => {
      const query = {};
      if(req.query.companyId){
        query.companyId = req.query.companyId;
      }
      if(req.query.status){
        query.status = req.query.status;
      }
      const cursor = jobsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/api/jobs/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await jobsCollection.findOne(query);
      res.send(result);
    });

    // Admin: Update job status
    app.patch('/api/jobs/:id/status', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      if (!status || !['active', 'closed', 'draft'].includes(status)) {
        return res.status(400).send({ error: "Invalid status. Must be 'active', 'closed', or 'draft'." });
      }
      let filter;
      try {
        filter = { _id: new ObjectId(id) };
      } catch(e) {
        return res.status(400).send({ error: "Invalid job ID" });
      }
      const updateResult = await jobsCollection.updateOne(filter, {
        $set: { status: status, updatedAt: new Date() }
      });
      if (updateResult.matchedCount === 0) {
        return res.status(404).send({ error: "Job not found" });
      }
      res.send({ success: true, status: status });
    });

    // Admin: Delete a job
    app.delete('/api/jobs/:id', async (req, res) => {
      const id = req.params.id;
      let result;
      try {
        result = await jobsCollection.deleteOne({ _id: new ObjectId(id) });
      } catch(e) {
        return res.status(400).send({ error: "Invalid job ID" });
      }
      if (result.deletedCount === 0) {
        return res.status(404).send({ error: "Job not found" });
      }
      res.send({ success: true });
    });

    app.post("/api/jobs", async (req, res) => {
        const job = req.body;

        // Check if the company is approved before allowing job posting
        if (job.companyId) {
          const company = await companiesCollection.findOne({ id: job.companyId });
          if (!company) {
            return res.status(404).send({ error: "Company not found. Please register a company first." });
          }
          if (company.status !== "approved") {
            return res.status(403).send({ error: "Your company must be approved by an admin before you can post jobs." });
          }
        }

        const newJob = {
          ...job,
          createdAt: new Date(),
        }
        const result = await jobsCollection.insertOne(newJob);
        res.send(result);
    });
    
    app.post("/api/applications", async (req, res) => {
      const application = req.body;
      
      if (application.applicantId) {
        // Fetch user to determine their plan and limit
        let planLimit = 3; // Default limit
        try {
          // Check for user by id (better-auth standard) or _id (mongodb standard)
          let user = await usersCollection.findOne({ id: application.applicantId });
          if (!user) user = await usersCollection.findOne({ _id: application.applicantId });
          if (!user) {
            try { user = await usersCollection.findOne({ _id: new ObjectId(application.applicantId) }); } catch(e){}
          }
          
          if (user && user.plan) {
            if (user.plan === 'seeker_premium') planLimit = Infinity;
            else if (user.plan === 'seeker_pro') planLimit = 30;
          }
        } catch (e) {
          console.error("Error fetching user plan:", e);
        }

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        
        const monthlyCount = await applicationsCollection.countDocuments({
          applicantId: application.applicantId,
          createdAt: { $gte: startOfMonth, $lte: endOfMonth }
        });
        
        if (monthlyCount >= planLimit) {
          return res.status(403).send({ error: `You have reached your plan limit of ${planLimit} applications per month.` });
        }
      }

      const newApplication = {
        ...application,
        createdAt: new Date(),
      }
      const result = await applicationsCollection.insertOne(newApplication);
      res.send(result);
    });

    app.get("/api/applications", async(req, res) => {
      const query = {}
      if(req.query.applicantId){
        query.applicantId = req.query.applicantId;
      }
      if(req.query.jobId){
        query.jobId = req.query.jobId;
      }
      const cursor = applicationsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get("/api/applications/check", async (req, res) => {
      const { jobId, applicantId } = req.query;
      if (!jobId || !applicantId) return res.send({ hasApplied: false });
      const application = await applicationsCollection.findOne({ jobId, applicantId });
      res.send({ hasApplied: !!application });
    });

    app.get("/api/applications/my", async (req, res) => {
      const { applicantId } = req.query;
      if (!applicantId) return res.send({ appliedJobIds: [], monthlyCount: 0 });
      const applications = await applicationsCollection.find({ applicantId }).toArray();
      const appliedJobIds = applications.map(app => app.jobId);
      
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      
      const monthlyCount = applications.filter(app => {
        if (!app.createdAt) return false;
        const appDate = new Date(app.createdAt);
        return appDate.getMonth() === currentMonth && appDate.getFullYear() === currentYear;
      }).length;

      res.send({ appliedJobIds, monthlyCount });
    });

    app.post(["/api/companies", "/api/my/companies"], async (req, res) => {
      const company = req.body;
      const newCompany = {
          ...company,
        createdAt: new Date(),
      }
      const result = await companiesCollection.insertOne(newCompany);
      res.send(result);
    });

    app.get(['/api/companies', '/api/my/companies'], async (req, res) => {
      const query = {};
      if(req.query.recruiterId){
        query.recruiterId = req.query.recruiterId;
      }
      if(req.query.status){
        query.status = req.query.status;
      }
      const cursor = companiesCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Get a single company by MongoDB _id
    app.get('/api/companies/:id', async (req, res) => {
      const id = req.params.id;
      let company = null;
      try {
        company = await companiesCollection.findOne({ _id: new ObjectId(id) });
      } catch(e) {
        company = await companiesCollection.findOne({ id: id });
      }
      if (!company) {
        return res.status(404).send({ error: "Company not found" });
      }
      res.send(company);
    });

    // Admin: Approve or reject a company
    app.patch('/api/companies/:id/status', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // "approved" or "rejected"
      if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).send({ error: "Invalid status. Must be 'approved', 'rejected', or 'pending'." });
      }
      let filter;
      try {
        filter = { _id: new ObjectId(id) };
      } catch(e) {
        filter = { id: id };
      }
      const updateResult = await companiesCollection.updateOne(filter, {
        $set: { status: status, updatedAt: new Date() }
      });
      if (updateResult.matchedCount === 0) {
        return res.status(404).send({ error: "Company not found" });
      }
      res.send({ success: true, status: status });
    });

    //plan related api

    app.get('/api/plans', async(req, res)=>{
      const query = {};
      if(req.query.plan_id){
        query.id = req.query.plan_id
      }
      const plan = await plansCollection.findOne(query);
      res.json(plan || null);
    })

    //subscription api
    app.post('/api/subscriptions', async(req, res) => {
      const subscription = req.body;
      const newSubscription = {
        ...subscription,
        createdAt: new Date(),
      }
      const result = await subscriptionsCollection.insertOne(newSubscription);

      //update the user info
      const filter = {email: subscription.email};
      const updateDocument = {
        $set: {
          plan: subscription.planId,
        },
      };
      const updateResult = await usersCollection.updateOne(filter, updateDocument);

      res.send(updateResult);
    })

    app.get('/api/subscriptions', async(req, res) => {
      const email = req.query.email;
      if (!email) {
        return res.status(400).send({ error: "Email is required" });
      }
      const query = { email: email };
      const subscriptions = await subscriptionsCollection.find(query).sort({ createdAt: -1 }).toArray();
      res.send(subscriptions);
    });

    // Saved Jobs APIs
    app.post('/api/saved-jobs', async (req, res) => {
      const { userId, jobId } = req.body;
      if (!userId || !jobId) return res.status(400).send({ error: "Missing required fields" });
      
      const existing = await savedJobsCollection.findOne({ userId, jobId });
      if (existing) {
        await savedJobsCollection.deleteOne({ userId, jobId });
        return res.send({ success: true, saved: false });
      } else {
        await savedJobsCollection.insertOne({ userId, jobId, createdAt: new Date() });
        return res.send({ success: true, saved: true });
      }
    });

    app.get('/api/saved-jobs', async (req, res) => {
      const { userId } = req.query;
      if (!userId) return res.status(400).send({ error: "Missing userId" });
      
      const savedJobs = await savedJobsCollection.find({ userId }).sort({ createdAt: -1 }).toArray();
      
      const jobIds = savedJobs.map(sj => {
        try { return new ObjectId(sj.jobId) } catch(e) { return sj.jobId }
      });
      
      const jobs = await jobsCollection.find({ 
        $or: [
          { _id: { $in: jobIds } },
          { id: { $in: jobIds.filter(id => typeof id === 'string') } }
        ]
      }).toArray();
      
      res.send(jobs);
    });
    
    app.get('/api/saved-jobs/ids', async (req, res) => {
      const { userId } = req.query;
      if (!userId) return res.status(400).send({ error: "Missing userId" });
      
      const savedJobs = await savedJobsCollection.find({ userId }).toArray();
      const ids = savedJobs.map(sj => sj.jobId);
      res.send(ids);
    });







    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
