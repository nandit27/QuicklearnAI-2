const student = require('../models/student.model');
const teacher = require('../models/teacher.model');
const admin = require('../models/admin.model');
const jwt = require('jsonwebtoken');
const redis = require('../redis.connection');

async function handlelogin(req, res) {
    const { email, password, role } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }
    // console.log(email, password, role);
    try {
        let user;
        if (role === 'student') {
            user = await student.findOne({ email })
                .select('+membership +membershipDetails +usage');
            if (!user || user.password !== password) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }
        } else if(role === 'admin') {
            user = await admin.findOne({ email });
            if (!user || user.password !== password) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }
        } else if (role === 'teacher') {
            user = await teacher.findOne({ email });
            console.log(user)
            if (user == null || user.password !== password) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }
            
            // Check if teacher account is approved
            if (user.approvalStatus !== 'approved') {
                return res.status(403).json({ 
                    message: 'Your account is pending approval by admin',
                    approvalStatus: user.approvalStatus
                });
            }

            user.isOnline = true;
            //insert the user to the redis
            redis.sadd('online_teachers', user._id);
            
            // Safely handle subjects array - check if it exists and has items
            let subjects = [];
            if (user.subject && Array.isArray(user.subject) && user.subject.length > 0) {
                subjects = user.subject.map(sub => ({
                    field: sub.field || '',
                    subcategory: sub.subcategory || ''
                }));
            } else {
                // Default empty subject if none exists
                subjects = [{ field: '', subcategory: '' }];
            }
            
            console.log('field', subjects[0].field, 
                "subcategory", subjects[0].subcategory)
            redis.hmset(`teacher:${user._id}`, 
                'email', user.email, 
                'username', user.username, 
                'rating', user.rating || 0, 
                'doubtsSolved', user.doubtsSolved || 0, 
                'field', subjects[0].field, 
                "subcategory", subjects[0].subcategory, 
                'certification', JSON.stringify(user.certification || [])
            );
        } else {
            return res.status(400).json({ message: 'Invalid role' });
        }

        // Generate token for all successful logins
        const token = jwt.sign(
            { id: user._id, role: user.role || role, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set cookie for all successful logins
        res.cookie('authtoken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000
        });

        const userResponse = {
            _id: user._id,
            email: user.email,
            username: user.username,
            isOnline: user.isOnline || false,
            avatar: user.avatar || '',
            role: role,
            rating: user.rating || 0,
            doubtsSolved: user.doubtsSolved || 0,
            subject: user.subject || [],
            certification: user.certification || []
        };

        // Add membership details for students
        if (role === 'student') {
            userResponse.membership = {
                type: user.membership,
                details: user.membershipDetails,
                usage: user.usage,
                status: user.membershipDetails?.status || 'pending',
                expiresAt: user.membershipDetails?.endDate || null,
                features: {
                    ytSummary: {
                        limit: user.membershipDetails?.features?.ytSummary || 3,
                        used: user.usage?.summarizedVideos || 0
                    },
                    quizzes: {
                        limit: user.membershipDetails?.features?.quiz || 0,
                        taken: user.usage?.quizzesTaken || 0
                    }
                }
            };
        }

        // Send consistent response format for all roles
        return res.status(200).json({
            message: 'Login successful',
            user: userResponse,
            token
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

async function handleregister(req, res) {
    try {
        const { email, password, role, username, phone } = req.body;

        // Basic validation
        if (!email || !role || !username) {
            return res.status(400).json({
                message: 'Email, role, and username are required'
            });
        }

        let user;
        let newUser;

        // Check if user already exists
        if (role === 'student') {
            user = await student.findOne({ email });
            if (user) {
                return res.status(400).json({ message: 'Student already exists' });
            }

            // Create new student
            newUser = await student.create({
                email,
                password: password || null, // Make password optional for Google Auth
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`,
                username,
                phone: phone || null
            });

        }else if (role==='admin'){
            //find from the admin 
            user = await admin.findOne({ email });
            if (user) {
                return res.status(400).json({ message: 'Admin already exists' });
            }
            newUser = await admin.create({
                email,
                password: password || null, // Make password optional for Google Auth
                username,
                phone: phone || null
            });
            return res.status(201).json({ message: 'Admin registered successfully' });
        } 
        else if (role === 'teacher') {
            const {
                highestQualification,
                experience,
                subject,
                subcategory,
                certification
            } = req.body;

            user = await teacher.findOne({ email });
            if (user) {
                return res.status(400).json({ message: 'Teacher already exists' });
            }

                    // Process subject data to ensure correct format
            let formattedSubjects = [];
            if (subject && subcategory) {
                // Create subject object with field and subcategory array
                const subjectObject = {
                    field: subject,
                    subcategory: Array.isArray(subcategory) ? subcategory : [subcategory]
                };
                formattedSubjects = [subjectObject];
}
           // Create new teacher with required fields and proper subject format
            newUser = await teacher.create({
                email,
                password: password || '1234', // Required for teachers
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`,
                username,
                phone: phone || '',
                highestQualification: highestQualification || '',
                experience: experience || 0,
                subject: formattedSubjects,
                certification: certification ? (Array.isArray(certification) ? certification : [certification]) : [],
                approvalStatus: 'pending'
            });
            
            // For teachers, don't generate token - they need admin approval first
            return res.status(201).json({
                message: 'Teacher registration submitted successfully. Your account is pending admin approval.',
                user: {
                    _id: newUser._id,
                    email: newUser.email,
                    username: newUser.username,
                    avatar: newUser.avatar,
                    role,
                    subject: formattedSubjects,
                    approvalStatus: 'pending'
                }
            });
        } else {
            return res.status(400).json({ message: 'Invalid role' });
        }

        // Generate JWT token - only for students and admins
        const token = jwt.sign(
            { id: newUser._id, role, email: newUser.email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set HTTP-only cookie
        res.cookie('authtoken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        // Return user info without sensitive data
        const userResponse = {
            _id: newUser._id,
            email: newUser.email,
            username: newUser.username,
            avatar: newUser.avatar,
            role
        };

        res.status(201).json({
            message: 'Registration successful',
            user: userResponse,
            token
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({
            message: 'Internal server error',
            error: err.message
        });
    }
}

async function handlelogout(req, res) {
    try {
        res.clearCookie('authtoken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        });
        res.status(200).json({ message: 'Logout successful' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

module.exports = {
    handlelogin,
    handlelogout,
    handleregister
};
