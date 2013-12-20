/*

2013 Alan Languirand
@13protons

*/

var express = require('express')
    , lessMiddleware = require('less-middleware')
    , http = require('http')
    , url = require('url')
    , fs = require('fs')
    , path = require('path')
    , ejs = require('ejs')
    , passport = require('passport')
    , GitHubStrategy = require('passport-github').Strategy
    , extend = require('node.extend')
    , app = express()
    , Firebase = require('firebase')
    , config = require('./config'); //make sure it's pointing in the right direction. config.js doesn't sync w/ git

var fbURL = config['FIREBASE_FORGE']; //firebase endpoint

var resources = {
    "headers":  {"title": "Headers", "type": "header", "updateURL": fbURL + "/resources/headers", "id": "headers", "rel": "/headers", "color": "blue"},
    "verbs":    {"title": "Verbs", "type": "verb", "updateURL": fbURL + "/resources/verbs", "id": "verbs", "rel": "/verbs", "color": "green"},
    "codes":    {"title": "Codes", "type": "code", "updateURL": fbURL + "/resources/codes", "id": "codes", "rel": "/codes", "color": "yellow"}
};

/* next prev cache */
/* Build a chache from firebase resources to keep in memory. Rebuild every so often */
/* it hurts to have to do this with a realtime db, but not having next/prev sibling filtering demands drastic measures */
var resource_cache = {
	cache: [],
	lookup: {},
	keep_alive: 1000 * 60 * 10, /* in miliseconds, 0 to only build on startup */
	rebuild: function(){
		console.log("rebuilding cache...");
		var context = this;
		var tmp_cache = {
			counts: 0,
			content: [],
			index: []
		};
		//walk the "resources" object and keep a reference to each anticipated URL for the resources in question
		for(type in resources){
			tmp_cache.index.push(type);
			var n = new Firebase(resources[type].updateURL);
			n.once('value', function(s){
				for(r in s.val()){
					var a = {
						'resource': r,
						'url': tmp_cache.index[tmp_cache.counts] + "/" + r
					}
					
					tmp_cache.content.push(a);
				}
				tmp_cache.counts ++;
				try_save_cache(tmp_cache.counts);
			});
		}
		
		function try_save_cache(x){
			//only move local tmp_cache into parent this.cache if we've recieved every expected reponse from firebase
			if(x >= Object.keys(resources).length){
				context.cache = tmp_cache.content;
				for(i in tmp_cache.content){
					context.lookup[tmp_cache.content[i].url] = i;
				}
				//console.log(context.lookup);
				console.log('cache rebuilt');
			}
			
		}
	},
	init: function(){
		this.rebuild();
		if(this.keep_alive > 0){
			setInterval(this.rebuild.bind(this), this.keep_alive);
		}
	}
}
resource_cache.init();

var gitHubStrategy = new GitHubStrategy({
        clientID: config['GITHUB_CLIENT'],
        clientSecret: config['GITHUB_SECRET'],
        callbackURL: config['REDIRECT'] //change for production
      },oauthCallBack);

function oauthCallBack(accessToken, refreshToken, profile, done){
 //save provider, id, display
    var p = {
        "provider": profile.provider,
        "id": profile.id,
        "displayName": profile.displayName,
    };
    console.log('logging in ',p);

    var user = new Firebase(fbURL + '/users/' + profile.id);
    user.once('value', function(snapshot){
        if(snapshot.val() == null){
            //create that user
            console.log('creating user...');
            var users = new Firebase(fbURL + '/users');
            users.child(p.id).set(p, function(e){
                return done(e,p);
            });
        }else{
            return done(null,p);
        }
    });
}

passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    console.log('Deserialize user : ',id);
    var user = new Firebase(fbURL + '/users/' + id);
    user.once('value', function(snapshot){
        done(null, snapshot.val());
    });
}); 

    app.engine('.html', require('ejs').__express);
    app.set('views', __dirname + '/views');
    app.set('view engine', 'html');

    //less is more? 
    app.use(lessMiddleware({
        src      : __dirname + '/public',
        compress : true
    }));

    app.use(express.static(path.join(__dirname, 'public'))); //  "public" off of current is root
    app.use(express.favicon());

    //setup logging
    app.use(express.logger('dev'));

    //Configure sessions and passport
    app.use(express.cookieParser(config['SESSION_SECRET'])); //make it a good one
    app.use(express.session({secret: config['SESSION_SECRET']}));
    app.use(passport.initialize());
    app.use(passport.session());
    
    // Use the GitHubStrategy within Passport.
    //   Strategies in Passport require a `verify` function, which accept
    //   credentials (in this case, an accessToken, refreshToken, and GitHub
    //   profile), and invoke a callback with a user object.
    passport.use(gitHubStrategy);

    app.use(app.router);
    app.use(function(req,res,next){
        res.statusCode = 404;
        res.render('404', {
                    "page":  "not_found",
                    "user": req.user,
                    "name": "/404"
                });
    });
        
    //Handle "?last=x if available
    app.get('/auth/github', function(req, res, next) {
        if(typeof(req.query.last) == "undefined"){ req.session.last = '/'; }
        else{ req.session.last = req.query.last }
        
          passport.authenticate('github', function(err, user, info) {
            if (err) { return next(err); }
            if (!user) { return res.redirect(req.session.last); }
            req.logIn(user, function(err) {
              if (err) { return next(err); }
              return res.redirect(req.session.last);
            });
          })(req, res, next);
    });


    app.get('/auth/github/callback', 
      passport.authenticate('github', { failureRedirect: '/login' }),
      function(req, res) {
        req.session['auth'] = true;
        res.redirect(req.session.last);
    });

    app.get('/logout', function(req, res){

        var last = req.session.last || req.query.last || '/';
        req.session.destroy(function (err) {
            //res.redirect('/'); //Inside a callback… bulletproof!
            //req.session['auth'] = false;
            res.redirect(last);
        });
        //req.logout();            
    });

    //default page
    app.get('/', function(req, res) {
        //should this be automated or stuck in config.js? Not yet, but probably in a more flexible version
        res.render(__dirname + '/views/vis.ejs', {
                "resources": resources,
                "page": "home", 
                "user": getUser(req),
                "name": "",
                "data": resources //JSON.stringify(output)
        });
	});

    app.get('/:type/:title', function(req, res){
		
        var user = null;
        var full_user = getUser(req);
        if(full_user !== null){
            user = full_user.id;
        }
        
        var d = {
            "type": req.params.type,
            "title": req.params.title
        };
		
		d = extend(d, {
			uid:  d.type + d.title,
			name: "resources/" + d.type + "/" + d.title,
			lookup: d.type + "/" + d.title
		});
		
		d.index = resource_cache.lookup[d.lookup];
		//console.log(d);
		
        console.log("GET ", d.name);

        var resource = new Firebase(fbURL + '/' + d.name);

        resource.once('value', function(snap_r){
            //if logged in, we'd look for the user ID in the users up & down objects and raise "you voted" flag
            var data = snap_r.val();

            if(data === null){
                res.statusCode = 404;
                return res.render('404', {
                    "page":  "not_found",
                    "user": full_user,
                    "name": "/404"
                });
            }
			//console.log('index', d.index + 1);
			data.prev = resource_cache.cache[parseInt(d.index) - 1];
			data.next = resource_cache.cache[parseInt(d.index) + 1];
			
            data.priority = snap_r.getPriority();
            var v = req.query.vote;

            if(user == null)
                return render_resource();

            //console.log(fbURL + '/users/' + user + '/votes/' + d.name);
            var didVote = new Firebase(fbURL + '/users/' + user + '/votes/' + d.name);

            didVote.once('value', function(snap_d){
                    data.your_vote = snap_d.val();
                    
                    //this if block actually does the voting!
                    if(typeof(v) != "undefined" && user !== null){
    
                        //voting! Yup, that's 12 possible references to update
                        var update = {
                            resource: {
                                self: new Firebase(fbURL + '/' + d.name + '/votes/raw'),
                                down: new Firebase(fbURL + '/' + d.name + '/votes/down'),
                                up: new Firebase(fbURL + '/' + d.name + '/votes/up'),
                                total: new Firebase(fbURL + '/' + d.name + '/votes/total'),
                                user: new Firebase(fbURL + '/' + d.name + '/votes/raw/' + user)
                            },
                            user: {
                                self: new Firebase(fbURL + '/users/' + user + '/votes/'),
                                down: new Firebase(fbURL + '/users/' + user + '/votes/down'),
                                up: new Firebase(fbURL + '/users/' + user + '/votes/up'),
                                total: new Firebase(fbURL + '/users/' + user + '/votes/total'),
                                resource: new Firebase(fbURL + '/users/' + user + '/votes/' + d.name)
                            },
                            raw: {
                                self: new Firebase(fbURL + '/votes'),
                                total: new Firebase(fbURL + '/votes/total'),
                                user: new Firebase(fbURL + '/votes/' + d.name + '/' + user)
                            }      
                        };

                        function vote(boolean){
                            var targetResourceName = d.name;
                            update.resource.self.child(user).set(boolean);
                            update.user.self.child(targetResourceName).set(boolean);
                            update.raw.self.child(d.name).child(user).set(boolean);
                            
                            //update vote for resource
                            update.resource.total.transaction(function(c) { return c + 1; });
                            update.user.total.transaction(function(c) { return c + 1; });
                            update.raw.total.transaction(function(c) { return c + 1; });
                            
                            if(boolean){
                                update.resource.up.transaction(function(c) { return c + 1; });
                                update.user.up.transaction(function(c) { return c + 1; });
                            }else{
                                update.resource.down.transaction(function(c) { return c + 1; });
                                update.user.down.transaction(function(c) { return c + 1; });
                            }

                        }

                        function reduceTotals(x){
                                //remove previous votes 
                                update.resource.user.remove();
                                update.user.resource.remove();
                                update.raw.user.remove();
                                
                                //decrement total counters
                                update.resource.total.transaction(function(c) { return c - 1; });
                                update.user.total.transaction(function(c) { return c - 1; });
                                update.raw.total.transaction(function(c) { return c - 1; });
                                
                                if(data.your_vote === false || data.your_vote === null){
                                    update.resource.down.transaction(function(c) { return c - 1; });
                                    update.user.down.transaction(function(c) { return c - 1; });
                                }
                                
                                if(data.your_vote === true || data.your_vote === null){
                                    update.resource.up.transaction(function(c) { return c - 1; });
                                    update.user.up.transaction(function(c) { return c - 1; });
                                }
                            
                        }

                        if(v == "remove" && data.your_vote !== null){
                           console.log("remove vote");
                           reduceTotals(data.your_vote);
                        }

                        if(v == "up" && data.your_vote !== true){
                            //vote up                            
                            if(data.your_vote === false){
                                console.log('changing down to up');
                                reduceTotals(data.your_vote);
                            }
                            vote(true);
                        }

                        if(v == "down" && data.your_vote !== false){
                            //vote down
                            if(data.your_vote === true){
                                console.log('changing up to down');
                                reduceTotals(data.your_vote);
                            }
                            vote(false);           
                        }

                        //res.redirect(req._parsedUrl.pathname);
                        res.send();
                        
                    }else {
                        render_resource();
                    }
            });
            
            function render_resource(){
                data.votes.percent = 0;
                if(data.votes.total > 0){ data.votes.percent = Math.round((data.votes.up/data.votes.total) * 100); }
                data.votes.percent_display = data.votes.percent + "%";
                
                data = extend(data, resources[d.type]);
                
                res.render(__dirname + '/views/resource_show.ejs', {
                    "r": data,
                    "page": "resource",
                    "user": full_user,
                    "name": "/"+ d.type +"/"+ d.title,
                    "updateURL": resource
                });
            
            }
            
            
        });   
       
    });

    app.get('/:page', function(req, res) {
        user = getUser(req);
	  	fs.stat(__dirname + '/views/' + req.params.page + ".ejs", function(err){
	  		if(err){
                res.statusCode = 404;
				res.render('404', {
                    "page":  "not_found",
                    "user": user,
                    "name": "/404"
                });
	  		}else{
	  			res.render(__dirname + '/views/' + req.params.page + ".ejs", {
                    "data": resources,
                    "page": req.params.page,
                    "user": user,
                    "name": "/" + req.params.page
                });
	  			
	  		}
	  	});

	});

    /*
	app.locals({
	  table  : function(list) {
	    var template = fs.readFileSync(__dirname + '/views/table.ejs', 'utf-8');
	    return ejs.render(template, list);
	  },
      message: ""
    
	});
*/

var port = process.env.PORT || 3000;
app.listen(port);

console.log('Listening on port %d', port);

function getUser(req){
    var user = null;
    if(typeof(req.user) != 'undefined'){ 
        user = req.user ;
    }
    return user;
}

function log(x){
    console.log(x);
}
